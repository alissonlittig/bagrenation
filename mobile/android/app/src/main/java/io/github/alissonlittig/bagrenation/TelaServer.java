package io.github.alissonlittig.bagrenation;

import java.net.InetSocketAddress;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;

// WebSocket só em 127.0.0.1, com senha de uso único: leva os quadros (JPEG) e o som da tela para a página do app.
class TelaServer extends WebSocketServer {
    private final String token;
    private final Runnable entrou;
    private final CountDownLatch pronto = new CountDownLatch(1);

    TelaServer(int port, String token, Runnable entrou) {
        super(new InetSocketAddress("127.0.0.1", port));
        this.token = token;
        this.entrou = entrou;
        setReuseAddr(true);
        setTcpNoDelay(true);
        setConnectionLostTimeout(0);
    }

    boolean esperar(long ms) {
        try { return pronto.await(ms, TimeUnit.MILLISECONDS); } catch (InterruptedException e) { return false; }
    }

    int clientes() { return getConnections().size(); }

    void enviar(byte[] b) {
        for (WebSocket c : getConnections()) {
            // quem está atrasado perde o quadro em vez de acumular atraso
            if (c.isOpen() && (b[0] != 1 || !c.hasBufferedData())) {
                try { c.send(b); } catch (Exception ignored) {}
            }
        }
    }

    void parar() {
        try { stop(300); } catch (Exception ignored) {}
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake hs) {
        String r = hs.getResourceDescriptor();
        if (r == null || !r.equals("/?t=" + token)) { conn.close(1008, "senha"); return; }
        if (entrou != null) entrou.run();
    }

    @Override public void onClose(WebSocket conn, int code, String reason, boolean remote) {}
    @Override public void onMessage(WebSocket conn, String message) {}
    @Override public void onError(WebSocket conn, Exception ex) {}
    @Override public void onStart() { pronto.countDown(); }
}
