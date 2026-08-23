/**
 * Pop the 3D viewport out to its own OS window.
 *
 * A React PORTAL into a `window.open` document: both windows share one JS
 * context, so the zustand store, the three.js scene, and every event handler
 * keep working with zero message-passing. The main window meanwhile drops
 * its viewport column and maximizes the authoring surface (tree | lanes |
 * inspector, full width — the layout the user asked for).
 *
 * WebGL note: the canvas element MOVES to the child document. Browsers keep
 * the GL context alive through reparenting via portal because React never
 * unmounts the subtree — only the DOM node's parent changes. The R3F Canvas
 * itself stays mounted the whole time.
 *
 * Style note: the child window starts with an EMPTY document — none of the
 * app's stylesheets. Every <style> and <link rel=stylesheet> is cloned over
 * before the portal renders, so the viewport looks identical out there.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface PopoutState {
  container: HTMLElement;
  win: Window;
}

export function usePopout(onClosed: () => void) {
  const [popout, setPopout] = useState<PopoutState | null>(null);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  const open = useCallback(() => {
    const win = window.open(
      '',
      'assembly-studio-viewport',
      'width=1280,height=860,menubar=no,toolbar=no,location=no,status=no',
    );
    if (!win) return; // popup blocked — stay docked

    win.document.title = 'Assembly Studio — Viewport';

    // Clone every stylesheet so the child window renders identically.
    for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) {
      win.document.head.appendChild(node.cloneNode(true));
    }

    const container = win.document.createElement('div');
    container.className = 'popout-root';
    win.document.body.style.margin = '0';
    win.document.body.style.background = '#0d1017';
    win.document.body.appendChild(container);

    win.addEventListener('beforeunload', () => {
      setPopout(null);
      onClosedRef.current();
    });

    setPopout({ container, win });
  }, []);

  const close = useCallback(() => {
    popout?.win.close();
    setPopout(null);
  }, [popout]);

  // Closing the MAIN window must not orphan the child.
  useEffect(() => {
    const closeChild = () => popout?.win.close();
    window.addEventListener('beforeunload', closeChild);
    return () => window.removeEventListener('beforeunload', closeChild);
  }, [popout]);

  return {
    isOut: popout !== null,
    open,
    close,
    /** Render children into the popped window (or inline when docked). */
    portal: (children: React.ReactNode) =>
      popout ? createPortal(children, popout.container) : children,
  };
}
