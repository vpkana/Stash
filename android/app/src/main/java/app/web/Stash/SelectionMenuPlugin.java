package app.web.Stash;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Tell the Android layer whether the web layer is currently editing a note body.
 *
 * The native Cut / Copy / Paste menu over a WebView selection is an
 * {@code ActionMode} that Android builds for us. Stash draws its own selection
 * toolbar in the note editor, so while the body is the active surface the native
 * one has to stay away — but only there. The title, the link field and the search
 * box are ordinary native inputs whose own paste menu is still the right UI, so
 * the suppression is a flag the editor raises and lowers as the caret moves in
 * and out of the body, not a global switch.
 *
 * The flag is read by {@link MainActivity#onWindowStartingActionMode} on the UI
 * thread and written from the plugin thread, hence {@code volatile}: the value
 * only ever moves between "show the native menu" and "show none", so a torn read
 * is not possible for a boolean, and a value that arrives a few milliseconds
 * early or late only changes which of the two menus appears for that gesture.
 */
@CapacitorPlugin(name = "SelectionMenu")
public class SelectionMenuPlugin extends Plugin {

    private static volatile boolean suppressed = false;

    /** Read by the activity when Android asks it for a floating action mode. */
    static boolean isNativeMenuSuppressed() {
        return suppressed;
    }

    /**
     * Set from the editor's focus / pointer events.
     *
     * `suppressed` is a request about *future* selections: it does not dismiss a
     * menu that is already on screen, because the editor's own selection listener
     * has already replaced that with its React toolbar.
     */
    @PluginMethod
    public void setSuppressed(PluginCall call) {
        suppressed = Boolean.TRUE.equals(call.getBoolean("suppressed", false));
        call.resolve();
    }
}
