import { describe, expect, it, vi } from 'vitest';
import { openStripe } from './client';

/** Just the parts of Window that openStripe touches. */
function fakeWindow(options: { framed: boolean; topBlocked?: boolean; popupBlocked?: boolean }) {
  const top = {
    location: {
      set href(url: string) {
        if (options.topBlocked) throw new DOMException('cross-origin', 'SecurityError');
        top.went = url;
      },
    },
    went: undefined as string | undefined,
  };
  const tab = { opener: {} as unknown };
  const win = {
    location: { assign: vi.fn() },
    open: vi.fn(() => (options.popupBlocked ? null : tab)),
    top: undefined as unknown,
  };
  win.top = options.framed ? top : win;
  return { win: win as unknown as Window, top, tab, assign: win.location.assign, open: win.open };
}

describe('openStripe', () => {
  it('moves the whole tab when the scanner is inside the website’s frame', () => {
    const { win, top, assign } = fakeWindow({ framed: true });
    openStripe('https://checkout.stripe.com/c/1', win);
    expect(top.went).toBe('https://checkout.stripe.com/c/1');
    expect(assign).not.toHaveBeenCalled();
  });

  it('opens a new tab when the browser won’t let the frame move the tab', () => {
    const { win, tab, assign, open } = fakeWindow({ framed: true, topBlocked: true });
    openStripe('https://checkout.stripe.com/c/1', win);
    expect(open).toHaveBeenCalledWith('https://checkout.stripe.com/c/1', '_blank');
    expect(tab.opener).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });

  it('falls back to the frame itself when new tabs are blocked too', () => {
    const { win, assign } = fakeWindow({ framed: true, topBlocked: true, popupBlocked: true });
    openStripe('https://checkout.stripe.com/c/1', win);
    expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/1');
  });

  it('navigates normally when the scanner is the whole page', () => {
    const { win, assign, open } = fakeWindow({ framed: false });
    openStripe('https://billing.stripe.com/p/1', win);
    expect(assign).toHaveBeenCalledWith('https://billing.stripe.com/p/1');
    expect(open).not.toHaveBeenCalled();
  });
});
