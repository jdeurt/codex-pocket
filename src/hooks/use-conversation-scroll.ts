"use client";
import { useLayoutEffect, useRef, useState } from "react";

const END_THRESHOLD = 64;

export function useConversationScroll(suspended: boolean) {
  const viewport = useRef<HTMLDivElement>(null);
  const saved = useRef<number | undefined>(undefined);
  const [following, setFollowing] = useState(true);
  useLayoutEffect(() => {
    const element = viewport.current;

    if (!element) {
      return;
    }

    if (suspended) {
      saved.current = element.scrollTop;
    } else if (saved.current !== undefined) {
      element.scrollTop = saved.current;
      saved.current = undefined;
    }
  }, [suspended]);

  return {
    viewportRef: viewport,
    autoScroll: following && !suspended,
    onScroll: () => {
      const element = viewport.current;

      if (element && !suspended) {
        setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < END_THRESHOLD);
      }
    },
  };
}
