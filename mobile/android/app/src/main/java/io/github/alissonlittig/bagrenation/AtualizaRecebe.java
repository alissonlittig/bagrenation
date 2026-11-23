package io.github.alissonlittig.bagrenation;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

/** Resultado da sessão do PackageInstaller (S-0069) e o aviso de "app atualizado" do próprio Android. */
public class AtualizaRecebe extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(i.getAction())) {
            Atualizador.limparVelhos(c, Atualizador.meuCodigo(c));
            Atualizador.agendar(c);
            return;
        }
        int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String ver = i.getStringExtra("ver");
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmar = i.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirmar != null) Atualizador.pedirToque(c, confirmar, ver);
        } else if (st == PackageInstaller.STATUS_SUCCESS) {
            Atualizador.anota(c, "instalado " + ver);
        } else {
            Atualizador.anota(c, "instalação de " + ver + " não foi: status " + st + " " + i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
        }
    }
}
