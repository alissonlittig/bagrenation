package io.github.alissonlittig.bagrenation;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

// Ponte do site com o Android: chamada em segundo plano, captura de tela, avisos, tela cheia e atualização.
@CapacitorPlugin(
    name = "Bagre",
    permissions = {
        @Permission(alias = "notif", strings = { Manifest.permission.POST_NOTIFICATIONS }),
        @Permission(alias = "bt", strings = { Manifest.permission.BLUETOOTH_CONNECT }),
        @Permission(alias = "mic", strings = { Manifest.permission.RECORD_AUDIO, Manifest.permission.MODIFY_AUDIO_SETTINGS })
    }
)
public class BagrePlugin extends Plugin {
    static BagrePlugin inst;
    static final String REPO_API = "https://api.github.com/repos/alissonlittig/bagrenation/releases/latest";
    static final String CH_MSG = "mensagens";
    private int notifId = 100;
    private PluginCall shareCall;

    @Override
    public void load() {
        inst = this;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = getContext().getSystemService(NotificationManager.class);
            NotificationChannel c = new NotificationChannel(CH_MSG, "Mensagens e quem entrou", NotificationManager.IMPORTANCE_HIGH);
            c.setDescription("Mensagem nova no chat e amigo entrando na voz");
            nm.createNotificationChannel(c);
        }
    }

    // botão voltar: o site fecha o que estiver aberto; true = tratou
    boolean voltar() {
        if (!hasListeners("back")) return false;
        notifyListeners("back", new JSObject());
        return true;
    }

    void emitir(String ev, JSObject d) { notifyListeners(ev, d == null ? new JSObject() : d); }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        try {
            PackageInfo pi = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            r.put("version", pi.versionName);
            r.put("code", Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode);
        } catch (Exception e) { r.put("version", "?"); }
        r.put("sdk", Build.VERSION.SDK_INT);
        r.put("model", Build.MANUFACTURER + " " + Build.MODEL);
        call.resolve(r);
    }

    // ---------- permissões (aviso de mensagem e fone Bluetooth) ----------
    @PluginMethod
    public void permissoes(PluginCall call) {
        java.util.List<String> a = new java.util.ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33 && !ok(Manifest.permission.POST_NOTIFICATIONS)) a.add("notif");
        if (Build.VERSION.SDK_INT >= 31 && !ok(Manifest.permission.BLUETOOTH_CONNECT)) a.add("bt");
        if (a.isEmpty()) { call.resolve(estado()); return; }
        requestPermissionForAliases(a.toArray(new String[0]), call, "permissoesFim");
    }

    @PermissionCallback
    private void permissoesFim(PluginCall call) { call.resolve(estado()); }

    private boolean ok(String p) { return ContextCompat.checkSelfPermission(getContext(), p) == PackageManager.PERMISSION_GRANTED; }

    private JSObject estado() {
        JSObject r = new JSObject();
        r.put("notif", Build.VERSION.SDK_INT < 33 || ok(Manifest.permission.POST_NOTIFICATIONS));
        r.put("bt", Build.VERSION.SDK_INT < 31 || ok(Manifest.permission.BLUETOOTH_CONNECT));
        r.put("mic", ok(Manifest.permission.RECORD_AUDIO));
        return r;
    }

    // ---------- chamada de voz em segundo plano ----------
    @PluginMethod
    public void callState(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        String txt = call.getString("text", "Na voz");
        Intent i = new Intent(getContext(), CallService.class);
        i.setAction(on ? CallService.A_CALL_ON : CallService.A_CALL_OFF);
        i.putExtra("text", txt);
        try {
            if (on) ContextCompat.startForegroundService(getContext(), i);
            else if (CallService.inst != null) getContext().startService(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("serviço da chamada não abriu: " + e.getMessage());
        }
    }

    // ---------- avisos ----------
    @PluginMethod
    public void notify(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && !ok(Manifest.permission.POST_NOTIFICATIONS)) { call.reject("sem permissão de aviso"); return; }
        Intent open = new Intent(getContext(), MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        PendingIntent pi = PendingIntent.getActivity(getContext(), 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(getContext(), CH_MSG)
            .setSmallIcon(R.drawable.ic_stat_bagre)
            .setColor(0xFF14B6C8)
            .setContentTitle(call.getString("title", "BAGRENATION"))
            .setContentText(call.getString("body", ""))
            .setStyle(new NotificationCompat.BigTextStyle().bigText(call.getString("body", "")))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(pi);
        try {
            NotificationManagerCompat.from(getContext()).notify(notifId++, b.build());
            call.resolve();
        } catch (SecurityException e) { call.reject("sem permissão de aviso"); }
    }

    // ---------- tela cheia: gira junto quando a transmissão é deitada ----------
    @PluginMethod
    public void fullscreen(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        boolean land = Boolean.TRUE.equals(call.getBoolean("landscape", false));
        Activity a = getActivity();
        a.runOnUiThread(() -> a.setRequestedOrientation(on && land ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED));
        call.resolve();
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        try {
            getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(call.getString("url"))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    @PluginMethod
    public void toBack(PluginCall call) {
        getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
        call.resolve();
    }

    // ---------- compartilhar tela (MediaProjection; o WebView não tem getDisplayMedia) ----------
    @PluginMethod
    public void shareStart(PluginCall call) {
        if (shareCall != null) { call.reject("já escolhendo"); return; }
        MediaProjectionManager mpm = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        shareCall = call;
        bridge.saveCall(call);
        startActivityForResult(call, mpm.createScreenCaptureIntent(), "shareResult");
    }

    @ActivityCallback
    private void shareResult(PluginCall call, ActivityResult r) {
        shareCall = null;
        if (call == null) return;
        if (r.getResultCode() != Activity.RESULT_OK || r.getData() == null) { call.reject("cancelado", "NotAllowedError"); return; }
        CallService.Pedido p = new CallService.Pedido();
        p.code = r.getResultCode();
        p.data = r.getData();
        p.w = call.getInt("w", 1280);
        p.h = call.getInt("h", 720);
        p.fps = Math.max(5, Math.min(30, call.getInt("fps", 30)));
        p.audio = Boolean.TRUE.equals(call.getBoolean("audio", true));
        p.pronto = (port, token, w, h, audio, erro) -> {
            if (erro != null) { call.reject(erro); return; }
            JSObject o = new JSObject();
            o.put("port", port); o.put("token", token); o.put("w", w); o.put("h", h); o.put("audio", audio);
            call.resolve(o);
        };
        CallService.pedido = p;
        Intent i = new Intent(getContext(), CallService.class).setAction(CallService.A_SHARE_ON);
        try {
            ContextCompat.startForegroundService(getContext(), i);
        } catch (Exception e) {
            CallService.pedido = null;
            call.reject("serviço da tela não abriu: " + e.getMessage());
        }
    }

    @PluginMethod
    public void shareStop(PluginCall call) {
        if (CallService.inst != null) getContext().startService(new Intent(getContext(), CallService.class).setAction(CallService.A_SHARE_OFF));
        call.resolve();
    }

    // ---------- atualização: Release mais nova do GitHub, baixa o APK e abre o instalador ----------
    @PluginMethod
    public void latest(PluginCall call) {
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(REPO_API).openConnection();
                c.setRequestProperty("Accept", "application/vnd.github+json");
                c.setRequestProperty("User-Agent", "bagrenation-android");
                c.setConnectTimeout(15000); c.setReadTimeout(20000);
                if (c.getResponseCode() != 200) { call.reject("GitHub " + c.getResponseCode()); return; }
                InputStream in = c.getInputStream();
                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                byte[] bb = new byte[16384];
                int nn;
                while ((nn = in.read(bb)) > 0) bo.write(bb, 0, nn);
                String body = new String(bo.toByteArray(), StandardCharsets.UTF_8);
                in.close();
                JSONObject j = new JSONObject(body);
                JSObject r = new JSObject();
                r.put("tag", j.optString("tag_name"));
                r.put("name", j.optString("name"));
                r.put("notes", j.optString("body"));
                JSONArray as = j.optJSONArray("assets");
                if (as != null) for (int k = 0; k < as.length(); k++) {
                    JSONObject a = as.getJSONObject(k);
                    if ("BAGRENATION.apk".equals(a.optString("name"))) { r.put("apk", a.optString("browser_download_url")); r.put("size", a.optLong("size")); }
                }
                call.resolve(r);
            } catch (Exception e) { call.reject("sem conexão com o GitHub: " + e.getMessage()); }
        }).start();
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        String url = call.getString("url");
        String tag = call.getString("tag", "novo");
        if (url == null || !url.startsWith("https://github.com/alissonlittig/bagrenation/")) { call.reject("endereço do APK estranho"); return; }
        new Thread(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "update");
                dir.mkdirs();
                File f = new File(dir, "BAGRENATION-" + tag.replaceAll("[^0-9A-Za-z.]", "") + ".apk");
                if (!f.exists() || f.length() < 100000) {
                    File tmp = new File(dir, "baixando.part");
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setInstanceFollowRedirects(true);
                    c.setRequestProperty("User-Agent", "bagrenation-android");
                    c.setConnectTimeout(20000); c.setReadTimeout(60000);
                    int st = c.getResponseCode();
                    if (st != 200) { call.reject("download " + st); return; }
                    long total = c.getContentLengthLong(), got = 0, last = 0;
                    try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(tmp)) {
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            out.write(buf, 0, n);
                            got += n;
                            if (total > 0 && got - last > total / 50) { last = got; JSObject p = new JSObject(); p.put("p", (double) got / total); emitir("apkProgress", p); }
                        }
                    }
                    if (!tmp.renameTo(f)) { call.reject("não deu para salvar o APK"); return; }
                }
                Context ctx = getContext();
                if (Build.VERSION.SDK_INT >= 26 && !ctx.getPackageManager().canRequestPackageInstalls()) {
                    // 1ª vez: o Android pede para liberar "instalar apps desta fonte"; depois o botão abre o instalador direto
                    getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName())));
                    JSObject r = new JSObject(); r.put("liberar", true); call.resolve(r);
                    return;
                }
                Uri u = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
                Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(u, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().startActivity(i);
                JSObject r = new JSObject(); r.put("aberto", true); call.resolve(r);
            } catch (Exception e) { call.reject("falhou: " + e.getMessage()); }
        }).start();
    }
}
