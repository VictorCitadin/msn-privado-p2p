package com.vitinhowill.msnprivado.tablet;

import android.view.Window;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Tela cheia de verdade (esconde as barras do Android) para assistir filmes no compartilhamento
 * de tela, e tela sempre acesa durante a ligação.
 *
 * O requestFullscreen() do WebView não funciona no Capacitor (o BridgeWebChromeClient descarta o
 * pedido), por isso o modo imersivo é feito aqui no lado nativo.
 */
@CapacitorPlugin(name = "Immersive")
public class ImmersivePlugin extends Plugin {

    /** Lido pela MainActivity: com a tela cheia ativa, o botão voltar só sai da tela cheia. */
    static volatile boolean immersiveActive = false;

    @PluginMethod
    public void enter(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(window, window.getDecorView());
            // As barras voltam temporariamente com um deslize da borda e somem de novo sozinhas
            controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            controller.hide(WindowInsetsCompat.Type.systemBars());
            immersiveActive = true;
            call.resolve();
        });
    }

    @PluginMethod
    public void exit(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            WindowCompat.getInsetsController(window, window.getDecorView())
                .show(WindowInsetsCompat.Type.systemBars());
            immersiveActive = false;
            call.resolve();
        });
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) {
                getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
            call.resolve();
        });
    }
}
