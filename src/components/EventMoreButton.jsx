import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export default function EventMoreButton({ count, lane, onClick, onDoubleClick, onMouseEnter, onMouseLeave }) {
  const containerRef = useRef(null);
  const measureRef = useRef(null);
  const fullLabel = `${count}개 더보기`;
  const shortLabel = `${count}개 ...`;
  const [useShortLabel, setUseShortLabel] = useState(false);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const measureEl = measureRef.current;
    if (!container || !measureEl) return;
    setUseShortLabel(measureEl.offsetWidth > container.clientWidth);
  }, [fullLabel]);

  useLayoutEffect(() => {
    measure();
    const container = containerRef.current;
    if (!container) return;

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [measure]);

  return (
    <button
      ref={containerRef}
      type="button"
      className="event-more"
      style={{ '--event-lane': lane }}
      aria-label={fullLabel}
      title={useShortLabel ? fullLabel : undefined}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <span ref={measureRef} className="event-more-measure" aria-hidden="true">
        {fullLabel}
      </span>
      {useShortLabel ? shortLabel : fullLabel}
    </button>
  );
}
