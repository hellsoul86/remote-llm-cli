import { useEffect, useRef, useState } from "react";

import { type SessionAlert } from "./types";

export function useSessionAlerts() {
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermission>(
      typeof Notification === "undefined" ? "denied" : Notification.permission,
    );
  const [sessionAlerts, setSessionAlerts] = useState<SessionAlert[]>([]);
  const [sessionAlertsExpanded, setSessionAlertsExpanded] = useState(true);
  const previousAlertCountRef = useRef(0);

  useEffect(() => {
    if (sessionAlerts.length > previousAlertCountRef.current) {
      setSessionAlertsExpanded(true);
    }
    previousAlertCountRef.current = sessionAlerts.length;
  }, [sessionAlerts.length]);

  function pushSessionAlert(alert: Omit<SessionAlert, "id">) {
    const id = `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const next: SessionAlert = { id, ...alert };
    setSessionAlerts((prev) => {
      const duplicate = prev.some(
        (item) =>
          item.threadID === next.threadID &&
          item.title === next.title &&
          item.body === next.body,
      );
      if (duplicate) return prev;
      const withNext = [...prev, next];
      if (withNext.length <= 24) return withNext;
      return withNext.slice(withNext.length - 24);
    });
  }

  function dismissSessionAlert(alertID: string) {
    setSessionAlerts((prev) => prev.filter((item) => item.id !== alertID));
  }

  function clearSessionAlerts() {
    setSessionAlerts([]);
  }

  async function onEnableNotifications() {
    if (typeof Notification === "undefined") {
      setNotificationPermission("denied");
      return;
    }
    const result = await Notification.requestPermission();
    setNotificationPermission(result);
  }

  function notifySessionDone(title: string, body: string) {
    if (typeof Notification === "undefined") return;
    if (notificationPermission !== "granted") return;
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "visible"
    ) {
      return;
    }
    try {
      const note = new Notification(title, { body, silent: false });
      window.setTimeout(() => note.close(), 6000);
    } catch {
      // Notification failures are non-fatal for session completion flow.
    }
  }

  return {
    notificationPermission,
    sessionAlerts,
    sessionAlertsExpanded,
    setSessionAlertsExpanded,
    pushSessionAlert,
    dismissSessionAlert,
    clearSessionAlerts,
    onEnableNotifications,
    notifySessionDone,
  };
}
