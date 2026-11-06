package app.web.Stash;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Tells the WebView whether Android's own selection menu should be suppressed.
 *
 * The note editor draws its own bar over a selection, so it asks for the
 * platform's to be withheld while the body is the surface being edited — and
 * gives it back when the body is left, because the title, the search field and
 * the link field all still want the menu they have always had.
 *
 * Kept as a plugin rather than inferred natively because only the web layer
 * knows which of its many editable surfaces the selection belongs to; the
 * native side just holds the answer. See `StashWebView` for what suppression
 * actually does, and why it cannot be done by refusing the action mode outright.
 */
@CapacitorPlugin(name = "SelectionMenu")
public class SelectionMenuPlugin extends Plugin {

    @PluginMethod
    public void setSuppressed(PluginCall call) {
        Boolean suppressed = call.getBoolean("suppressed", Boolean.FALSE);
        StashWebView.setSelectionMenuSuppressed(Boolean.TRUE.equals(suppressed));
        call.resolve();
    }
}
