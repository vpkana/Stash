'use client';

import { create } from 'zustand';

/**
 * Whether a note editor is on screen.
 *
 * One boolean, and it exists for one layout decision that cannot be made from the
 * route: **the bottom navigation is not drawn while a note is open**.
 *
 * That is the fix for the keyboard overlap on Android. The tab bar is a fixed
 * strip at the bottom of the layout, so when the soft keyboard comes up and the
 * WebView resizes to make room, the bar is pushed up and sits *on top of* the
 * keyboard — a strip of navigation buttons over the keys, with the writing
 * toolbar balanced above it. Hiding it removes the overlap at the source instead
 * of compensating with an offset that would have to guess a keyboard height.
 *
 * Asked of the editor itself rather than of the URL, because the editor is what
 * actually knows: it is true for exactly as long as an editable surface is
 * mounted, and it cannot get out of step with a route that changed underneath it.
 * The alternative — parsing `?note=` in the shell — would also have to answer for
 * a note that failed to load, a route that grew a second editor, and history
 * navigation. A ref-counted flag owned by the component is simpler and true.
 */
interface EditorState {
  noteOpen: boolean;
  setNoteOpen: (value: boolean) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  noteOpen: false,
  setNoteOpen: (value) => set({ noteOpen: value }),
}));
