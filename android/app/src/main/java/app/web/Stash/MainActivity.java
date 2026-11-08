package app.web.Stash;

import android.os.Bundle;
import android.view.ActionMode;

import androidx.activity.EdgeToEdge;
import androidx.appcompat.app.ActionBar;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * Register the plugins that are local to the app rather than shipped as npm
     * packages. Capacitor's own plugins register themselves from the generated
     * plugin manifest; these five are small enough to live here, and keeping
     * them local means the parts that touch Android-specific behaviour — the
     * window flags, the incoming share, the Google token exchange, the native
     * day/night mode and the text-selection menu slot — have no third-party
     * dependency.
     *
     * The share receiver needs no further wiring: registering it before
     * `super.onCreate` is enough, because Capacitor replays the launching intent
     * (the cold-start share) through the plugin's `handleOnNewIntent`, and routes
     * every later one the same way.
     *
     * `EdgeToEdge.enable` is Capacitor's own recommendation for Capacitor 8 and
     * is what makes the window edge-to-edge on Android 14 and older too, where
     * Android does not force it. The window then extends under the status bar
     * and the gesture bar on every supported version, and the WebView reports
     * the insets the web layer lays itself out with -- one layout story across
     * devices instead of two. The CSS side never double-pads: when Capacitor
     * resolves to padding the WebView natively it reports zero insets.
     *
     * The theme is claimed *first*, and that ordering is load-bearing. The
     * activity is launched with `AppTheme.NoActionBarLaunch`, a splash theme;
     * AppCompat decides whether to install an ActionBar from whichever theme is
     * current when the window's decor is first inflated, and anything touching
     * the window before `super.onCreate` -- as `EdgeToEdge.enable` does -- can
     * inflate it while the splash theme is still in force. An ActionBar created
     * then is titled with the activity label and survives Capacitor's later
     * `setTheme`, leaving the app name in a bar above the app's own content. So
     * the no-action-bar theme goes on before any other window work.
     */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        setTheme(R.style.AppTheme_NoActionBar);

        EdgeToEdge.enable(this);
        registerPlugin(PrivacyScreenPlugin.class);
        registerPlugin(ShareReceiverPlugin.class);
        registerPlugin(GoogleAuthPlugin.class);
        registerPlugin(ThemeModePlugin.class);
        registerPlugin(SelectionMenuPlugin.class);
        super.onCreate(savedInstanceState);

        /*
         * Belt and braces for the same failure: if some future Capacitor or
         * androidx version installs an ActionBar anyway, take it away rather than
         * shipping a title bar nobody designed. `null` on a no-action-bar theme,
         * which is the normal case.
         */
        ActionBar actionBar = getSupportActionBar();
        if (actionBar != null) {
            actionBar.hide();
        }
    }

    /**
     * Give the WebView's floating text-selection menu an action mode that draws
     * nothing, while the note editor is the active surface.
     *
     * Returning `null` here — the obvious way to say "no menu" — does not do that.
     * Android reads `null` as "the window should start one", which is why the
     * native Cut / Copy bubble survives it. Answering with an object is what
     * actually takes the slot, and Chromium requires a non-null answer anyway:
     * with a null one it treats the selection as failed and clears it, handles
     * and all.
     *
     * `SelectionMenuPlugin` carries the "only while editing the note body" part,
     * because every other text surface in the app — the title, the link field,
     * the search box — is an ordinary native input whose own Cut / Paste menu is
     * the right UI and must keep working.
     *
     * `TYPE_PRIMARY` is left to the framework: it is the action-bar mode used by
     * native widgets, and this app's ActionBar is deliberately absent.
     */
    @Override
    public ActionMode onWindowStartingActionMode(ActionMode.Callback callback, int type) {
        if (type == ActionMode.TYPE_FLOATING && SelectionMenuPlugin.isNativeMenuSuppressed()) {
            return new EmptySelectionActionMode(this, callback);
        }
        return super.onWindowStartingActionMode(callback, type);
    }
}
