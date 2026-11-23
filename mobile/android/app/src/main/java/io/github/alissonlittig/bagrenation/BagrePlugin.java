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
import androidx.activity.result.ActivityResult;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

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
        // S-0069: checa a Release ao abrir (só baixa e confere; instala quando o app sair da tela) e agenda a de 6 em 6 h
        Atualizador.agendar(getContext());
        new Thread(() -> Atualizador.ciclo(getContext(), false)).start();
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

    // ---------- atualização sozinha (S-0069): o trabalho é do Atualizador; aqui só o aviso do toque e o estado ----------
    void updPronto(String ver) {
        JSObject d = new JSObject();
        d.put("ver", ver);
        notifyListeners("updPronto", d, true);
    }

    @PluginMethod
    public void updInstalar(PluginCall call) {
        android.content.Intent i = Atualizador.pedeToque;
        if (i == null) { call.reject("nada para instalar"); return; }
        Atualizador.tirarAviso(getContext());
        getActivity().startActivity(i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        call.resolve();
    }

    @PluginMethod
    public void updEstado(PluginCall call) {
        android.content.SharedPreferences sp = Atualizador.prefs(getContext());
        JSObject r = new JSObject();
        r.put("versao", BuildConfig.VERSION_NAME);
        r.put("ultimo", sp.getString("ultimo", ""));
        r.put("pronto", sp.getString("pronto_ver", ""));
        r.put("podeInstalarSemToque", Build.VERSION.SDK_INT >= 31);
        r.put("fonteLiberada", Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls());
        call.resolve(r);
    }
}
