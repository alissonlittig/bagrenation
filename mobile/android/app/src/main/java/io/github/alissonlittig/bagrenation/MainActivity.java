package io.github.alissonlittig.bagrenation;

import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebView;
import android.widget.FrameLayout;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

// O site inteiro roda no WebView do Capacitor. Aqui só o que o WebView não faz sozinho:
// tela cheia de verdade (o Capacitor fecha a tela cheia na hora) e o botão voltar (não fecha o app na voz).
public class MainActivity extends BridgeActivity {
    private View fsView;
    private android.webkit.WebChromeClient.CustomViewCallback fsCb;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BagrePlugin.class);
        super.onCreate(savedInstanceState);
        WebView wv = getBridge().getWebView();
        wv.setBackgroundColor(Color.parseColor("#07040f"));
        wv.setWebChromeClient(new BridgeWebChromeClient(getBridge()) {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fsView != null) { callback.onCustomViewHidden(); return; }
                fsView = view;
                fsCb = callback;
                view.setBackgroundColor(Color.BLACK);
                ((FrameLayout) getWindow().getDecorView()).addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                imersivo(true);
            }

            @Override
            public void onHideCustomView() {
                if (fsView == null) return;
                ((FrameLayout) getWindow().getDecorView()).removeView(fsView);
                fsView = null;
                if (fsCb != null) fsCb.onCustomViewHidden();
                fsCb = null;
                imersivo(false);
            }
        });
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (fsView != null) {
                    getBridge().getWebView().evaluateJavascript("document.exitFullscreen && document.exitFullscreen().catch(function(){})", null);
                    return;
                }
                BagrePlugin p = BagrePlugin.inst;
                if (p != null && p.voltar()) return;
                moveTaskToBack(true); // voltar na tela principal: o app vai para trás (a voz continua), não fecha
            }
        });
    }

    void imersivo(boolean on) {
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (on) {
            c.hide(WindowInsetsCompat.Type.systemBars());
            c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            c.show(WindowInsetsCompat.Type.systemBars());
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }
    }
}
