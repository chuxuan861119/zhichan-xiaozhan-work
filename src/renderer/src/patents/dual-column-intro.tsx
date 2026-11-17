import { useEffect, useState } from "react";
import { SpatialPresence } from "../shared/spatial-presence";
import "./dual-column-intro.css";

const SEEN_KEY = "patent-dual-column-intro-seen";
export function DualColumnIntro({ enabled }: { enabled: boolean }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setVisible(false);
    if (!enabled || localStorage.getItem(SEEN_KEY)) return;
    let close: ReturnType<typeof setTimeout> | undefined;
    const open = setTimeout(() => {
      localStorage.setItem(SEEN_KEY, "1");
      setVisible(true);
      close = setTimeout(() => setVisible(false), 6000);
    }, 500);
    return () => {
      clearTimeout(open);
      clearTimeout(close);
    };
  }, [enabled]);
  return (
    <SpatialPresence>
      {enabled && visible ? (
        <div className="dual-column-intro" role="status">
          <span className="dual-column-intro__flow" aria-hidden="true">
            <i />
            <i />
            <b />
          </span>
          <span>
            同一文档，连续阅读
            <br />
            <small>左列底部接右列顶部</small>
          </span>
        </div>
      ) : null}
    </SpatialPresence>
  );
}
