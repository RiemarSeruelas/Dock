"use client";

import { Clock3 } from "lucide-react";
import { useEffect, useState } from "react";

const manilaTime = () => new Intl.DateTimeFormat("en-PH", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
  timeZone: "Asia/Manila",
}).format(new Date());

const manilaDate = () => new Intl.DateTimeFormat("en-PH", {
  weekday: "long",
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Manila",
}).format(new Date()).toUpperCase();

export function LiveClock({ className = "", showZone = true, showDate = false }: { className?: string; showZone?: boolean; showDate?: boolean }) {
  const [time, setTime] = useState("--:--:--");
  const [date, setDate] = useState("MANILA TIME");

  useEffect(() => {
    const update = () => {
      setTime(manilaTime());
      setDate(manilaDate());
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return <span className={`live-clock ${className}`.trim()} aria-label={`Current Manila time ${time}`}>
    <Clock3 size={14} />
    <b>{time}</b>
    {showDate ? <small>{date}</small> : showZone && <small>Manila</small>}
  </span>;
}
