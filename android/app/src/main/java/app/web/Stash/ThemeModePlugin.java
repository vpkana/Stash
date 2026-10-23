package app.web.Stash;

import android.app.Activity;

import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.app.AppCompatDelegate;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Hand the app's resolved theme to the native window.
 *
 * Stash paints every pixel of its own interface and follows its *own* theme,
 * which Settings can pin to light or dark regardless of what the phone is set
 * to. The native window has no idea about that: its day/night mode comes from
 * the device (uiMode), so every piece of Android chrome drawn from the activity
 * theme resolves against the wrong palette on the mismatch. The status bar got
 * this treatment already — see `syncSystemBars` in the web layer — and the text
 * selection toolbar is the same story one layer deeper.
 *
 * That toolbar (Cut / Copy / Paste over a selection in the WebView) is a
 * floating ActionMode themed by the activity. On a phone in dark mode with the
 * app in light mode it therefore renders as a black slab over light text —
 * legible in name only. Setting the activity's local night mode to match the
 * *app* fixes every themed native surface at once, not just the toolbar, and
 * has no side effects on the web palette: the WebView colours itself.
 *
 * `setLocalNightMode` normally recreates the activity, which on a WebView
 * means a page reload. It does not here: the manifest declares `uiMode` in
 * `android:configChanges`, so the system delivers the mode change to the
 * running activity instead of rebuilding it, and AppCompat re-themes the
 * activity's resources in place. Surfaces created afterwards — a selection
 * toolbar, a dialog — pick up the new palette; nothing reloads.
 *
 * The web layer calls this whenever its resolved theme changes, the same way it
 * styles the system bars, and off Android (or on a Capacitor version without
 * this plugin) the call simply rejects and the device default stays.
 */
@CapacitorPlugin(name = "ThemeMode")
public class ThemeModePlugin extends Plugin {

    @PluginMethod
    public void setNightMode(PluginCall call) {
        final boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", false));

        Activity activity = getActivity();
        if (!(activity instanceof AppCompatActivity)) {
            call.reject("No AppCompat activity to theme.");
            return;
        }
        AppCompatActivity host = (AppCompatActivity) activity;

        host.runOnUiThread(() -> {
            host.getDelegate().setLocalNightMode(
                dark ? AppCompatDelegate.MODE_NIGHT_YES : AppCompatDelegate.MODE_NIGHT_NO
            );
        });

        JSObject result = new JSObject();
        result.put("dark", dark);
        call.resolve(result);
    }
}
