package app.web.Stash;

import android.content.Context;
import android.util.AttributeSet;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuInflater;
import android.view.View;
import android.widget.PopupMenu;

import com.getcapacitor.CapacitorWebView;

/**
 * The app's WebView, with Android's own selection menu taken out of it.
 *
 * ## Why
 *
 * The Cut / Copy / Paste menu over a text selection is drawn by the platform
 * from the activity's theme. The app cannot size it, colour it or position it,
 * and on this WebView it arrives as a slab of background far larger than its
 * buttons, covering the note behind it. So Stash draws its own bar above the
 * selection (`rich-text-editor.tsx`) and asks for the platform's to be taken
 * away.
 *
 * ## Why a mode and not `null`
 *
 * `startActionMode` is where the platform asks the view to present that menu.
 * Returning `null` is not "no menu": WebView reads it as "the menu could not be
 * created" and clears the selection, so the text would deselect the instant it
 * was selected. A real, empty mode is returned instead — one with no menu, so
 * nothing is ever shown, but which WebView accepts as valid and keeps the
 * selection and its drag handles for.
 *
 * The handles are not this class's business either way: WebView draws them from
 * Blink and shows or hides them with focus, independently of the action mode.
 *
 * ## When
 *
 * Only while the note body is the surface being edited. The flag below is set
 * from the web layer through `SelectionMenuPlugin`, because the native menu is
 * wanted everywhere else — the title, the search field, the link field — and a
 * WebView-wide suppression would take it away from all of them.
 */
public class StashWebView extends CapacitorWebView {

    /** Written from the plugin thread, read on the UI thread when a mode starts. */
    private static volatile boolean selectionMenuSuppressed = false;

    public static void setSelectionMenuSuppressed(boolean suppressed) {
        selectionMenuSuppressed = suppressed;
    }

    private Menu emptyMenu;

    public StashWebView(Context context) {
        this(context, null);
    }

    public StashWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    public ActionMode startActionMode(ActionMode.Callback callback) {
        if (!selectionMenuSuppressed) return super.startActionMode(callback);
        return new SilentActionMode();
    }

    @Override
    public ActionMode startActionMode(ActionMode.Callback callback, int type) {
        if (!selectionMenuSuppressed) return super.startActionMode(callback, type);
        return new SilentActionMode();
    }

    /**
     * An action mode that shows nothing.
     *
     * Deliberately minimal. The only methods WebView calls on the mode it is
     * given are `finish`, `invalidate`, `invalidateContentRect`, `getType`,
     * `hide` and `onWindowFocusChanged`; everything bar `getType` is already
     * empty in `ActionMode`, so only the type is answered here, and every
     * abstract member is stubbed because the base class demands one.
     */
    private final class SilentActionMode extends ActionMode {

        @Override
        public int getType() {
            // WebView branches on the type it gets back; the menu it asked for
            // is a floating one, so say so and it keeps treating this as one.
            return TYPE_FLOATING;
        }

        @Override
        public void setTitle(CharSequence title) {}

        @Override
        public void setTitle(int resId) {}

        @Override
        public void setSubtitle(CharSequence subtitle) {}

        @Override
        public void setSubtitle(int resId) {}

        @Override
        public void setCustomView(View view) {}

        @Override
        public void invalidate() {}

        @Override
        public void finish() {}

        @Override
        public Menu getMenu() {
            if (emptyMenu == null) {
                // Never populated: it exists because the base class requires a
                // menu, not because there is one to show.
                emptyMenu = new PopupMenu(getContext(), StashWebView.this).getMenu();
            }
            return emptyMenu;
        }

        @Override
        public CharSequence getTitle() {
            return null;
        }

        @Override
        public CharSequence getSubtitle() {
            return null;
        }

        @Override
        public View getCustomView() {
            return null;
        }

        @Override
        public MenuInflater getMenuInflater() {
            return new MenuInflater(getContext());
        }
    }
}
