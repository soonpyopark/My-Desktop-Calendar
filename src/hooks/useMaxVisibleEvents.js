import { useEffect, useState } from 'react';
import {
  getEventLayoutCssVars,
  getEventRowCapacity,
} from '../../shared/eventLayoutMetrics.js';

export {
  getEventRowCapacity,
  resolveDayVisibleEventLimit,
} from '../../shared/eventLayoutMetrics.js';

/**
 * @param {React.RefObject<HTMLElement | null>} containerRef
 * @param {number} [weeksInViewport=5]
 */
export function useMaxVisibleEvents(containerRef, weeksInViewport = 5) {
  const [capacity, setCapacity] = useState(() => getEventRowCapacity(0));

  useEffect(() => {
    const container = containerRef.current;
    if (!container || weeksInViewport <= 0) return;

    let raf = 0;
    const update = () => {
      const rowHeight = container.clientHeight / weeksInViewport;
      setCapacity(getEventRowCapacity(rowHeight));
    };
    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };

    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    window.addEventListener('resize', schedule);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [containerRef, weeksInViewport]);

  return capacity;
}

export function useEventLayoutCssVars() {
  return getEventLayoutCssVars();
}
