package io.github.alissonlittig.bagrenation;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** Checagem de 6 em 6 h (S-0069), mesmo com o app fechado: baixa, confere e instala se o app não está na tela nem em chamada. */
public class AtualizaJob extends JobService {
    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            String r = Atualizador.ciclo(this, !Atualizador.visivel && !Atualizador.emChamada());
            android.util.Log.i(Atualizador.TAG, "checagem de 6 h: " + r);
            jobFinished(params, false);
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) { return true; }
}
