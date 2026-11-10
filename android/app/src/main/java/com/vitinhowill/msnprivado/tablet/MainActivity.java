package com.vitinhowill.msnprivado.tablet;

import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ImmersivePlugin.class);
        super.onCreate(savedInstanceState);

        // Botão voltar: na tela cheia, só sai dela; fora dela, manda o app para o fundo em vez de
        // fechá-lo (fechar derrubava a ligação e o chat no meio do filme).
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (ImmersivePlugin.immersiveActive && getBridge() != null) {
                    getBridge().triggerWindowJSEvent("vwExitFullscreen");
                } else {
                    moveTaskToBack(true);
                }
            }
        });
    }
}
