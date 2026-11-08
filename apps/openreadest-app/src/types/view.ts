import { BookDoc } from '@/libs/document';
import { BookNote, BookSearchConfig, BookSearchResult } from '@/types/book';
import { TTSGranularity } from '@/services/tts';
import { TTS } from 'foliate-js/tts.js';
import { LocaleWithTextInfo } from './misc';

export const NOTE_PREFIX = 'foliate-note:';

export interface FoliateView extends HTMLElement {
  open: (book: BookDoc) => Promise<void>;
  close: () => void;
  init: (options: { lastLocation: string }) => Promise<void>;
  /**
   * 跳转到 CFI / href / section index。
   *
   * 实际实现（packages/foliate-js/view.js）是 async 的，且**内部 try/catch 吞掉
   * 全部异常**：定位失败时只 console.error 并 `return undefined`，不会 reject。
   * 因此「没抛错」不能作为跳转成功的判据，必须看返回值是否为 undefined。
   * 此前的类型标注写成 `void`，调用方据此用 try/catch 判断成功，导致失败被当成
   * 成功、重试逻辑一次也不会执行。
   */
  goTo: (href: string | number) => Promise<{ index: number } | undefined>;
  goToFraction: (fraction: number) => void;
  prev: (distance?: number) => void;
  next: (distance?: number) => void;
  pan: (dx: number, dy: number) => void;
  isOverflowX: () => boolean;
  isOverflowY: () => boolean;
  goLeft: () => void;
  goRight: () => void;
  getCFI: (index: number, range: Range) => string;
  resolveCFI: (cfi: string) => { index: number; anchor: (doc: Document) => Range };
  resolveNavigation: (cfiOrHrefOrIndex: string | number) => {
    index: number;
    anchor?: (doc: Document) => Range;
  };
  addAnnotation: (
    note: BookNote & { value?: string },
    remove?: boolean,
  ) => { index: number; label: string };
  search: (config: BookSearchConfig) => AsyncGenerator<BookSearchResult | string, void, void>;
  clearSearch: () => void;
  select: (target: string | number | { fraction: number }) => void;
  deselect: () => void;
  initTTS: (
    granularity?: TTSGranularity,
    nodeFilter?: (node: Node) => number,
    highlight?: (range: Range) => void,
  ) => Promise<void>;
  book: BookDoc;
  tts: TTS | null;
  language: {
    locale?: LocaleWithTextInfo;
    isCJK?: boolean;
    canonical?: string;
    direction?: string;
  };
  history: {
    canGoBack: boolean;
    canGoForward: boolean;
    back: () => void;
    forward: () => void;
    clear: () => void;
  };
  renderer: {
    scrolled?: boolean;
    scrollLocked: boolean;
    size: number; // current page height
    viewSize: number; // whole document view height
    start: number;
    end: number;
    page: number;
    pages: number;
    primaryIndex?: number; // index of the primary (current) section view
    containerPosition: number;
    sideProp: 'width' | 'height';
    setAttribute: (name: string, value: string | number) => void;
    removeAttribute: (name: string) => void;
    next: () => Promise<void>;
    prev: () => Promise<void>;
    nextSection?: () => Promise<void>;
    prevSection?: () => Promise<void>;
    goTo?: (params: {
      index: number;
      anchor?: number | ((doc: Document) => Range);
    }) => Promise<void>;
    setStyles?: (css: string) => void;
    getContents: () => { doc: Document; index?: number; overlayer?: unknown }[];
    scrollToAnchor: (anchor: number | Range) => void;
    addEventListener: (
      type: string,
      listener: EventListener,
      option?: AddEventListenerOptions,
    ) => void;
    removeEventListener: (type: string, listener: EventListener) => void;
  };
}

export const wrappedFoliateView = (originalView: FoliateView): FoliateView => {
  const originalAddAnnotation = originalView.addAnnotation.bind(originalView);
  originalView.addAnnotation = (note: BookNote, remove = false) => {
    // transform BookNote to foliate annotation
    const annotation = {
      value: note.cfi,
      ...note,
    };
    return originalAddAnnotation(annotation, remove);
  };
  return originalView;
};

type RendererContent = ReturnType<FoliateView['renderer']['getContents']>[number];

/**
 * Resolve the content entry of the current (primary) section view.
 *
 * With multi-view preloading (foliate-js upstream), `getContents()` returns
 * every loaded section (older versions returned only the current one), so
 * `getContents()[0]` may point at a preloaded adjacent section instead of the
 * section being read. `renderer.primaryIndex` identifies the primary view;
 * fall back to the first entry like the upstream foliate-js code.
 */
export const getPrimaryContent = (renderer: FoliateView['renderer']): RendererContent | undefined =>
  renderer.getContents().find((content) => content.index === renderer.primaryIndex) ??
  renderer.getContents()[0];
