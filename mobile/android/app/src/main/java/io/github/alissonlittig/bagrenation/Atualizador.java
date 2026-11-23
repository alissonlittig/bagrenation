package io.github.alissonlittig.bagrenation;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Atualização sozinha do APK (S-0069), sem Play Store:
 * 1. olha a Release mais nova do GitHub (ao abrir o app e a cada 6 h pelo JobScheduler, mesmo com o app fechado);
 * 2. baixa o BAGRENATION.apk em segundo plano e confere o SHA-256 contra o SHA256SUMS.txt da mesma Release;
 * 3. confere que o APK é deste app, de versão maior e assinado com o MESMO certificado (outra assinatura = recusa);
 * 4. instala pelo PackageInstaller com USER_ACTION_NOT_REQUIRED (Android 12+). Sem toque quando o app atualiza a si mesmo,
 *    declara UPDATE_PACKAGES_WITHOUT_USER_ACTION, tem "instalar apps desta fonte" liberado e targetSdk recente (36).
 *    Se o Android ainda pedir toque (1ª vez, Android 11 ou menos): 1 aviso só, "Atualização pronta - Instalar".
 * Instalar fecha o app: só instala com o app fora da tela e sem chamada/tela compartilhada; aberto, deixa pronto e instala ao sair.
 */
public final class Atualizador {
    static final String TAG = "BagreUpd";
    static final String APK = "BAGRENATION.apk", SUMS = "SHA256SUMS.txt";
    static final String CH = "atualizacao";
    static final int NID = 9, JOB = 7001;
    static final String ACAO_STATUS = "io.github.alissonlittig.bagrenation.UPD_STATUS";
    static final long SEIS_H = 6L * 3600 * 1000;
    static volatile boolean visivel; // MainActivity na tela
    static volatile Intent pedeToque;  // Android pediu confirmação (STATUS_PENDING_USER_ACTION)
    private static final Object TRAVA = new Object();

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("atualizacao", Context.MODE_PRIVATE); }

    static void anota(Context c, String txt) {
        Log.i(TAG, txt);
        prefs(c).edit().putString("ultimo", txt).putLong("ultimo_t", System.currentTimeMillis()).apply();
    }

    static long meuCodigo(Context c) {
        try {
            PackageInfo pi = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
        } catch (Exception e) { return 0; }
    }

    static boolean emChamada() { CallService s = CallService.inst; return s != null && (s.inCall || s.sharing); }

    /** Agenda a checagem de 6 em 6 h (com internet); não duplica. */
    static void agendar(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js == null || js.getPendingJob(JOB) != null) return;
        JobInfo ji = new JobInfo.Builder(JOB, new ComponentName(c, AtualizaJob.class))
            .setPeriodic(SEIS_H)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPersisted(true)
            .build();
        try { // o agendamento nunca pode derrubar o app: falhou = anota e o app segue (checa de novo ao abrir)
            int r = js.schedule(ji);
            Log.i(TAG, "agendado a cada 6 h: " + (r == JobScheduler.RESULT_SUCCESS));
        } catch (RuntimeException e) { anota(c, "não agendou a checagem de 6 h: " + e); }
    }

    /** Ciclo inteiro. instalarJa = pode instalar agora (app fora da tela e sem chamada). Devolve o que aconteceu. */
    static String ciclo(Context c, boolean instalarJa) {
        synchronized (TRAVA) {
            try {
                return cicloTravado(c.getApplicationContext(), instalarJa);
            } catch (Exception e) {
                String m = "falhou: " + e;
                anota(c, m);
                return m;
            }
        }
    }

    private static String cicloTravado(Context c, boolean instalarJa) throws Exception {
        SharedPreferences p = prefs(c);
        long meu = meuCodigo(c);
        limparVelhos(c, meu);
        File pronto = new File(p.getString("pronto", ""));
        if (p.getLong("pronto_code", 0) > meu && pronto.isFile()) { // já baixado e conferido antes
            if (instalarJa) return instalar(c, pronto, p.getString("pronto_ver", "?"));
            return "pronto para instalar " + p.getString("pronto_ver", "?") + " (instala quando o app sair da tela)";
        }
        p.edit().putLong("checou", System.currentTimeMillis()).apply();
        JSONObject rel = new JSONObject(texto(BuildConfig.UPD_API, 2_000_000));
        String tag = rel.optString("tag_name").replaceFirst("^v", "");
        String urlApk = null, urlSums = null;
        JSONArray as = rel.optJSONArray("assets");
        if (as != null) for (int i = 0; i < as.length(); i++) {
            JSONObject a = as.getJSONObject(i);
            if (APK.equals(a.optString("name"))) urlApk = a.optString("browser_download_url");
            if (SUMS.equals(a.optString("name"))) urlSums = a.optString("browser_download_url");
        }
        if (!tag.matches("\\d+\\.\\d+\\.\\d+")) { anota(c, "release sem versão: " + tag); return "sem versão"; }
        if (compara(tag, BuildConfig.VERSION_NAME) <= 0) { anota(c, "em dia: " + BuildConfig.VERSION_NAME + " (release " + tag + ")"); return "em dia"; }
        if (urlApk == null || urlSums == null) { anota(c, "release " + tag + " sem " + APK + " ou " + SUMS); return "release incompleta"; }
        if (!urlApk.startsWith(BuildConfig.UPD_DL) || !urlSums.startsWith(BuildConfig.UPD_DL)) { anota(c, "endereço estranho na release: " + urlApk); return "endereço estranho"; }
        String esperado = null;
        for (String l : texto(urlSums, 100_000).split("\n")) {
            String[] x = l.trim().split("\\s+\\*?");
            if (x.length == 2 && APK.equals(x[1]) && x[0].matches("[0-9a-fA-F]{64}")) esperado = x[0].toLowerCase();
        }
        if (esperado == null) { anota(c, "SHA256SUMS sem a linha do " + APK); return "sem sha"; }

        File dir = new File(c.getFilesDir(), "atualizacao");
        dir.mkdirs();
        File f = new File(dir, "BAGRENATION-" + tag + ".apk"), tmp = new File(dir, "baixando.part");
        baixar(urlApk, tmp, 80L * 1024 * 1024);
        String sha = sha256(tmp);
        if (!sha.equals(esperado)) { tmp.delete(); anota(c, "RECUSADO " + tag + ": SHA-256 diferente (" + sha.substring(0, 12) + " != " + esperado.substring(0, 12) + ")"); return "sha diferente"; }
        String porque = conferirApk(c, tmp, meu);
        if (porque != null) { tmp.delete(); anota(c, "RECUSADO " + tag + ": " + porque); return porque; }
        f.delete();
        if (!tmp.renameTo(f)) throw new Exception("não salvou o APK");
        PackageInfo novo = c.getPackageManager().getPackageArchiveInfo(f.getPath(), 0);
        long code = Build.VERSION.SDK_INT >= 28 ? novo.getLongVersionCode() : novo.versionCode;
        p.edit().putString("pronto", f.getPath()).putLong("pronto_code", code).putString("pronto_ver", tag).apply();
        anota(c, "baixado e conferido " + tag + " (sha " + sha.substring(0, 12) + ", mesma assinatura)");
        if (instalarJa) return instalar(c, f, tag);
        return "pronto para instalar " + tag + " (instala quando o app sair da tela)";
    }

    /** null = ok; senão o motivo da recusa. */
    static String conferirApk(Context c, File f, long meu) throws Exception {
        PackageManager pm = c.getPackageManager();
        int flag = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo novo = pm.getPackageArchiveInfo(f.getPath(), flag);
        if (novo == null) return "APK ilegível";
        if (!c.getPackageName().equals(novo.packageName)) return "APK de outro app (" + novo.packageName + ")";
        long code = Build.VERSION.SDK_INT >= 28 ? novo.getLongVersionCode() : novo.versionCode;
        if (code <= meu) return "versão não é maior (" + code + " <= " + meu + ")";
        PackageInfo eu = pm.getPackageInfo(c.getPackageName(), flag);
        Set<String> a = certs(eu), b = certs(novo);
        if (a.isEmpty() || !a.equals(b)) return "assinatura diferente (certificado " + primeiro(b) + " != " + primeiro(a) + ")";
        return null;
    }

    private static Set<String> certs(PackageInfo pi) throws Exception {
        Signature[] s;
        if (Build.VERSION.SDK_INT >= 28) {
            if (pi.signingInfo == null) return new HashSet<>();
            s = pi.signingInfo.hasMultipleSigners() ? pi.signingInfo.getApkContentsSigners() : pi.signingInfo.getSigningCertificateHistory();
        } else s = pi.signatures;
        Set<String> r = new HashSet<>();
        if (s != null) for (Signature x : s) r.add(hex(MessageDigest.getInstance("SHA-256").digest(x.toByteArray())));
        // histórico de chave (rotação): vale o certificado atual, que é o último da lista; com 1 chave só é o mesmo
        return r;
    }

    private static String primeiro(Set<String> s) { return s.isEmpty() ? "nenhum" : s.iterator().next().substring(0, 12); }

    /** Sessão do PackageInstaller. Sem toque quando o Android aceita; o resultado chega no AtualizaRecebe. */
    static String instalar(Context c, File f, String ver) throws Exception {
        if (emChamada()) return "pronto, espera a chamada acabar";
        PackageInstaller pi = c.getPackageManager().getPackageInstaller();
        for (PackageInstaller.SessionInfo s : pi.getMySessions()) { try { pi.abandonSession(s.getSessionId()); } catch (Exception ignored) { } }
        PackageInstaller.SessionParams sp = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        sp.setAppPackageName(c.getPackageName());
        sp.setSize(f.length());
        if (Build.VERSION.SDK_INT >= 31) sp.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int id = pi.createSession(sp);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            try (InputStream in = new FileInputStream(f); OutputStream out = s.openWrite("base.apk", 0, f.length())) {
                byte[] b = new byte[65536];
                int n;
                while ((n = in.read(b)) > 0) out.write(b, 0, n);
                s.fsync(out);
            }
            Intent i = new Intent(c, AtualizaRecebe.class).setAction(ACAO_STATUS).putExtra("ver", ver);
            int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent pend = PendingIntent.getBroadcast(c, id, i, fl);
            anota(c, "instalando " + ver + " (sessão " + id + ", sem toque pedido: " + (Build.VERSION.SDK_INT >= 31) + ")");
            s.commit(pend.getIntentSender());
        }
        return "instalando " + ver;
    }

    /** O Android pediu confirmação: 1 aviso só (no app, se ele estiver na tela; senão na barra de avisos). */
    static void pedirToque(Context c, Intent confirmar, String ver) {
        pedeToque = confirmar;
        anota(c, "Android pediu 1 toque para instalar " + ver);
        BagrePlugin p = BagrePlugin.inst;
        if (visivel && p != null) { p.updPronto(ver); return; }
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            nm.createNotificationChannel(new NotificationChannel(CH, "Atualização", NotificationManager.IMPORTANCE_DEFAULT));
        }
        confirmar.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(c, NID, confirmar, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CH)
            .setSmallIcon(R.drawable.ic_stat_bagre)
            .setColor(0xFF14B6C8)
            .setContentTitle("Atualização pronta")
            .setContentText("BAGRENATION " + ver + " - toque para instalar")
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .addAction(0, "Instalar", pi);
        try { NotificationManagerCompat.from(c).notify(NID, b.build()); } catch (SecurityException e) { Log.i(TAG, "sem permissão de aviso"); }
    }

    static void tirarAviso(Context c) { NotificationManagerCompat.from(c).cancel(NID); }

    static void limparVelhos(Context c, long meu) {
        SharedPreferences p = prefs(c);
        if (p.getLong("pronto_code", 0) > meu) return;
        File dir = new File(c.getFilesDir(), "atualizacao");
        File[] fs = dir.listFiles();
        if (fs != null) for (File x : fs) x.delete(); // cópias do app já instaladas (pasta própria do app)
        if (p.contains("pronto")) {
            p.edit().remove("pronto").remove("pronto_code").remove("pronto_ver").apply();
            anota(c, "atualizado: agora na " + BuildConfig.VERSION_NAME);
            tirarAviso(c);
        }
    }

    static int compara(String a, String b) {
        String[] x = a.split("[.-]"), y = b.split("[.-]");
        for (int i = 0; i < 3; i++) {
            int p = i < x.length ? num(x[i]) : 0, q = i < y.length ? num(y[i]) : 0;
            if (p != q) return p - q;
        }
        return 0;
    }

    private static int num(String s) { try { return Integer.parseInt(s); } catch (Exception e) { return 0; } }

    private static HttpURLConnection abrir(String url) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        h.setInstanceFollowRedirects(true);
        h.setRequestProperty("User-Agent", "bagrenation-android");
        h.setRequestProperty("Accept", url.contains("api.github.com") ? "application/vnd.github+json" : "*/*");
        h.setConnectTimeout(20000);
        h.setReadTimeout(60000);
        int st = h.getResponseCode();
        if (st != 200) throw new Exception("HTTP " + st + " em " + url);
        return h;
    }

    static String texto(String url, int max) throws Exception {
        HttpURLConnection h = abrir(url);
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        try (InputStream in = h.getInputStream()) {
            byte[] b = new byte[16384];
            int n;
            while ((n = in.read(b)) > 0) { bo.write(b, 0, n); if (bo.size() > max) throw new Exception("resposta grande demais"); }
        }
        return new String(bo.toByteArray(), StandardCharsets.UTF_8);
    }

    static void baixar(String url, File dest, long max) throws Exception {
        HttpURLConnection h = abrir(url);
        long got = 0;
        try (InputStream in = h.getInputStream(); OutputStream out = new FileOutputStream(dest)) {
            byte[] b = new byte[65536];
            int n;
            while ((n = in.read(b)) > 0) { out.write(b, 0, n); got += n; if (got > max) throw new Exception("APK grande demais"); }
        }
    }

    static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) {
            byte[] b = new byte[65536];
            int n;
            while ((n = in.read(b)) > 0) md.update(b, 0, n);
        }
        return hex(md.digest());
    }

    static String hex(byte[] d) {
        StringBuilder sb = new StringBuilder();
        for (byte x : d) sb.append(String.format("%02x", x));
        return sb.toString();
    }
}
