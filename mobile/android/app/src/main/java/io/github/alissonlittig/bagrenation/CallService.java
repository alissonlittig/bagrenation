package io.github.alissonlittig.bagrenation;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Process;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.net.ServerSocket;
import java.nio.ByteBuffer;
import java.security.SecureRandom;

// Serviço em primeiro plano: segura a voz com o app atrás (microfone + som) e faz a captura da tela
// (MediaProjection -> JPEG pelo WebSocket local, som dos outros apps por AudioPlaybackCapture).
public class CallService extends Service {
    static final String TAG = "BagreCall";
    static final String A_CALL_ON = "call_on", A_CALL_OFF = "call_off", A_SHARE_ON = "share_on", A_SHARE_OFF = "share_off", A_LEAVE = "leave";
    static final String CH = "chamada";
    static final int NID = 7;
    static CallService inst;
    static Pedido pedido;

    interface Pronto { void ok(int port, String token, int w, int h, boolean audio, String erro); }
    static class Pedido { int code; Intent data; int w, h, fps; boolean audio; Pronto pronto; }

    boolean inCall, sharing;
    String callText = "Na voz";
    private MediaProjection projection;
    private VirtualDisplay vd;
    private ImageReader reader;
    private TelaServer server;
    private HandlerThread thr;
    private Handler h;
    private AudioRecord rec;
    private Thread recThr;
    private volatile boolean recOn;
    private int vw, vh, fps = 30, maxSide = 1280;
    private long lastFrame;
    private byte[] lastJpeg;
    private Bitmap bmp;
    private final ByteArrayOutputStream baos = new ByteArrayOutputStream(256 * 1024);

    @Override
    public void onCreate() {
        super.onCreate();
        inst = this;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel c = new NotificationChannel(CH, "Voz e tela", NotificationManager.IMPORTANCE_LOW);
            c.setDescription("Mostra que você está na voz ou compartilhando a tela");
            c.setShowBadge(false);
            getSystemService(NotificationManager.class).createNotificationChannel(c);
        }
        thr = new HandlerThread("bagre-tela", Process.THREAD_PRIORITY_DISPLAY);
        thr.start();
        h = new Handler(thr.getLooper());
    }

    @Override
    public int onStartCommand(Intent i, int flags, int startId) {
        String a = i == null ? null : i.getAction();
        if (A_CALL_ON.equals(a)) { inCall = true; if (i.hasExtra("text")) callText = i.getStringExtra("text"); primeiroPlano(); }
        else if (A_CALL_OFF.equals(a)) { inCall = false; pararTela(true); primeiroPlano(); }
        else if (A_SHARE_ON.equals(a)) { sharing = true; primeiroPlano(); iniciarTela(); }
        else if (A_SHARE_OFF.equals(a)) { pararTela(false); primeiroPlano(); }
        else if (A_LEAVE.equals(a)) {
            if (BagrePlugin.inst != null) BagrePlugin.inst.emitir(sharing && inCall ? "pararTela" : "sairVoz", null);
            else { inCall = false; pararTela(true); primeiroPlano(); }
        } else primeiroPlano();
        return START_NOT_STICKY;
    }

    private boolean temMic() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private void primeiroPlano() {
        if (!inCall && !sharing) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            stopSelf();
            return;
        }
        int tipos = 0;
        if (Build.VERSION.SDK_INT >= 29) {
            tipos = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
            if (inCall && temMic() && Build.VERSION.SDK_INT >= 30) tipos |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            if (sharing) tipos |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
        }
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        PendingIntent pi = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent sair = PendingIntent.getService(this, 2, new Intent(this, CallService.class).setAction(A_LEAVE), PendingIntent.FLAG_IMMUTABLE);
        String titulo = sharing ? "Compartilhando a tela" : callText;
        Notification n = new NotificationCompat.Builder(this, CH)
            .setSmallIcon(R.drawable.ic_stat_bagre)
            .setColor(0xFF14B6C8)
            .setContentTitle(titulo)
            .setContentText(sharing ? "Toque em Parar para encerrar a transmissão" : "BAGRENATION continua na voz com o app atrás")
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setContentIntent(pi)
            .addAction(0, sharing && inCall ? "Parar tela" : "Sair da voz", sair)
            .build();
        try {
            ServiceCompat.startForeground(this, NID, n, tipos);
        } catch (Exception e) {
            Log.w(TAG, "primeiro plano recusado (" + tipos + "): " + e);
            if (sharing) { // sem o tipo da tela a captura não pode abrir
                sharing = false;
                responder(0, null, 0, 0, false, "o Android recusou o serviço da tela: " + e.getMessage());
            }
        }
    }

    // ---------- tela ----------
    private void iniciarTela() {
        Pedido p = pedido;
        pedido = null;
        if (p == null) return;
        try {
            pararTela(false);
            sharing = true;
            MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            projection = mpm.getMediaProjection(p.code, p.data);
            if (projection == null) throw new IllegalStateException("sem permissão da captura");
            projection.registerCallback(new MediaProjection.Callback() {
                @Override public void onStop() { // parou pelo Android (barra de status, tela bloqueada, outro app)
                    h.post(() -> { if (sharing) { pararTela(false); primeiroPlano(); } });
                }
            }, h);
            fps = p.fps;
            maxSide = Math.max(640, Math.min(1920, Math.max(p.w, p.h)));
            medir();
            reader = ImageReader.newInstance(vw, vh, PixelFormat.RGBA_8888, 3);
            reader.setOnImageAvailableListener(this::quadro, h);
            int dpi = getResources().getDisplayMetrics().densityDpi;
            vd = projection.createVirtualDisplay("bagrenation", vw, vh, dpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, h);
            int port;
            try (ServerSocket s = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) { port = s.getLocalPort(); }
            byte[] rnd = new byte[18];
            new SecureRandom().nextBytes(rnd);
            String token = android.util.Base64.encodeToString(rnd, android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP | android.util.Base64.NO_PADDING);
            server = new TelaServer(port, token, () -> h.post(this::reenviar));
            server.start();
            if (!server.esperar(3000)) throw new IllegalStateException("servidor local não abriu");
            boolean audio = p.audio && iniciarSom();
            h.postDelayed(manter, 1000);
            p.pronto.ok(port, token, vw, vh, audio, null);
        } catch (Exception e) {
            Log.w(TAG, "tela não abriu", e);
            pararTela(true);
            primeiroPlano();
            p.pronto.ok(0, null, 0, 0, false, "não deu para capturar a tela: " + e.getMessage());
        }
    }

    private void responder(int port, String tk, int w, int hh, boolean a, String erro) {
        Pedido p = pedido;
        pedido = null;
        if (p != null) p.pronto.ok(port, tk, w, hh, a, erro);
    }

    private void medir() {
        DisplayMetrics m = new DisplayMetrics();
        ((WindowManager) getSystemService(WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(m);
        int dw = m.widthPixels, dh = m.heightPixels;
        double s = Math.min(1.0, (double) maxSide / Math.max(dw, dh));
        vw = Math.max(2, ((int) Math.round(dw * s)) & ~1);
        vh = Math.max(2, ((int) Math.round(dh * s)) & ~1);
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        if (!sharing || vd == null) return;
        h.post(() -> { // girou o celular: a tela capturada gira junto, sem esticar
            int ow = vw, oh = vh;
            medir();
            if (ow == vw && oh == vh) return;
            ImageReader old = reader;
            reader = ImageReader.newInstance(vw, vh, PixelFormat.RGBA_8888, 3);
            reader.setOnImageAvailableListener(this::quadro, h);
            vd.resize(vw, vh, getResources().getDisplayMetrics().densityDpi);
            vd.setSurface(reader.getSurface());
            bmp = null;
            if (old != null) old.close();
        });
    }

    private void quadro(ImageReader r) {
        Image img;
        try { img = r.acquireLatestImage(); } catch (Exception e) { return; }
        if (img == null) return;
        try {
            long now = SystemClock.uptimeMillis();
            if (server == null || server.clientes() == 0 || now - lastFrame < 1000 / fps - 4) return;
            lastFrame = now;
            Image.Plane pl = img.getPlanes()[0];
            ByteBuffer buf = pl.getBuffer();
            int ps = pl.getPixelStride(), rs = pl.getRowStride();
            int bw = rs / ps, iw = img.getWidth(), ih = img.getHeight();
            if (bmp == null || bmp.getWidth() != bw || bmp.getHeight() != ih) bmp = Bitmap.createBitmap(bw, ih, Bitmap.Config.ARGB_8888);
            bmp.copyPixelsFromBuffer(buf);
            Bitmap out = bw == iw ? bmp : Bitmap.createBitmap(bmp, 0, 0, iw, ih);
            baos.reset();
            baos.write(1);
            out.compress(Bitmap.CompressFormat.JPEG, 72, baos);
            if (out != bmp) out.recycle();
            lastJpeg = baos.toByteArray();
            server.enviar(lastJpeg);
        } catch (Exception e) {
            Log.w(TAG, "quadro", e);
        } finally {
            img.close();
        }
    }

    // tela parada não gera quadro: repete o último 1x/s (quem entra depois vê a imagem na hora)
    private final Runnable manter = new Runnable() {
        @Override public void run() {
            if (!sharing) return;
            if (SystemClock.uptimeMillis() - lastFrame > 900) reenviar();
            h.postDelayed(this, 1000);
        }
    };

    private void reenviar() { if (server != null && lastJpeg != null) server.enviar(lastJpeg); }

    private boolean iniciarSom() {
        if (Build.VERSION.SDK_INT < 29 || !temMic()) return false;
        try {
            AudioPlaybackCaptureConfiguration cfg = new AudioPlaybackCaptureConfiguration.Builder(projection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .excludeUid(Process.myUid()) // o próprio BAGRENATION (DJ, voz) fica de fora: quem assiste não se escuta
                .build();
            AudioFormat f = new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(48000).setChannelMask(AudioFormat.CHANNEL_IN_STEREO).build();
            int min = AudioRecord.getMinBufferSize(48000, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT);
            rec = new AudioRecord.Builder().setAudioFormat(f).setBufferSizeInBytes(Math.max(min, 3840 * 4)).setAudioPlaybackCaptureConfig(cfg).build();
            if (rec.getState() != AudioRecord.STATE_INITIALIZED) { rec.release(); rec = null; return false; }
            rec.startRecording();
            recOn = true;
            recThr = new Thread(() -> {
                byte[] b = new byte[1 + 3840]; // 20 ms de estéreo 16 bits 48 kHz, 1º byte = tipo
                b[0] = 2;
                while (recOn) {
                    int n = rec.read(b, 1, 3840);
                    if (n > 0 && server != null && server.clientes() > 0) {
                        byte[] o = n == 3840 ? b.clone() : java.util.Arrays.copyOf(b, 1 + n);
                        server.enviar(o);
                    }
                }
            }, "bagre-som");
            recThr.start();
            return true;
        } catch (Exception e) {
            Log.w(TAG, "som da tela não abriu", e);
            return false;
        }
    }

    private void pararTela(boolean silencioso) {
        boolean era = sharing;
        sharing = false;
        recOn = false;
        if (rec != null) { try { rec.stop(); } catch (Exception ignored) {} rec.release(); rec = null; }
        if (vd != null) { vd.release(); vd = null; }
        if (reader != null) { reader.close(); reader = null; }
        if (projection != null) { try { projection.stop(); } catch (Exception ignored) {} projection = null; }
        if (server != null) { server.parar(); server = null; }
        lastJpeg = null;
        bmp = null;
        if (era && !silencioso && BagrePlugin.inst != null) BagrePlugin.inst.emitir("shareEnded", new JSObject());
    }

    @Override
    public void onDestroy() {
        pararTela(true);
        inst = null;
        if (thr != null) thr.quitSafely();
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) { // app fechado pelos recentes: sai da voz
        inCall = false;
        pararTela(true);
        primeiroPlano();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public IBinder onBind(Intent i) { return null; }
}
