import { useEffect, type DependencyList, type RefObject } from 'react';
import { renderMermaidDiagrams } from '../utils/mermaid-renderer';

export function useMermaidDiagrams(
  ref: RefObject<ParentNode | null>,
  deps: DependencyList,
): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return undefined;

    let disposed = false;
    let scheduled = false;

    const scheduleRender = () => {
      if (disposed || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!disposed) void renderMermaidDiagrams(root);
      });
    };

    scheduleRender();

    if (typeof MutationObserver === 'undefined') {
      return () => {
        disposed = true;
      };
    }

    const observer = new MutationObserver(() => {
      scheduleRender();
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      disposed = true;
      observer.disconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- caller owns the render dependencies for injected HTML
  }, deps);
}
