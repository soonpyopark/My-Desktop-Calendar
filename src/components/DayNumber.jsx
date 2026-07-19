import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export default function DayNumber({ solar, lunarLabel, lunarDay }) {
  const rootRef = useRef(null);
  const measureRef = useRef(null);
  const fullDisplay = `(${lunarLabel})`;
  const [useShortLabel, setUseShortLabel] = useState(false);

  const measure = useCallback(() => {
    const root = rootRef.current;
    const measureEl = measureRef.current;
    if (!root || !measureEl || lunarLabel == null) return;

    const solarEl = root.querySelector('.solar');
    if (!solarEl) return;

    const gap = Number.parseFloat(getComputedStyle(root).columnGap || getComputedStyle(root).gap) || 0;
    setUseShortLabel(solarEl.offsetWidth + gap + measureEl.offsetWidth > root.clientWidth);
  }, [lunarLabel]);

  useLayoutEffect(() => {
    measure();
    const root = rootRef.current;
    if (!root) return;

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    return () => {
      observer.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [measure, solar, lunarLabel]);

  return (
    <div className="day-number" ref={rootRef}>
      <span className="solar">{solar}</span>
      {lunarLabel != null && lunarDay != null && (
        <>
          <span ref={measureRef} className="lunar-measure" aria-hidden="true">
            {fullDisplay}
          </span>
          <span className="lunar" title={useShortLabel ? fullDisplay : undefined}>
            ({useShortLabel ? lunarDay : lunarLabel})
          </span>
        </>
      )}
    </div>
  );
}
