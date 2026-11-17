import { useCallback, useEffect, useRef, useState } from "react";
import { APPLICATION_VERSION } from "../../../shared/branding";
import { UPDATE_OPEN_EVENT, type UpdateState } from "../../../shared/updates/model";

const initialState: UpdateState = {
  currentVersion: APPLICATION_VERSION,
  status: "idle",
  release: null,
  lastCheckedAt: null,
  notification: false,
  sourceHost: null,
  message: "尚未检查更新",
};
export function openSoftwareUpdates(check = true) {
  window.dispatchEvent(new CustomEvent(UPDATE_OPEN_EVENT, { detail: { check } }));
}
export function useSoftwareUpdates() {
  const [state, setState] = useState(initialState);
  const eventRevision = useRef(0);
  const api = window.patentApi?.updates;
  useEffect(() => {
    let current = true;
    let revision = 0;
    if (!api) {
      setState({
        ...initialState,
        status: "unavailable",
        message: "当前运行环境暂不支持更新检测。",
      });
      return;
    }
    const unsubscribe = api.onChanged((next) => {
      revision++;
      eventRevision.current++;
      if (current) setState(next);
    });
    const initialRevision = revision;
    void api
      .read()
      .then((result) => {
        if (current && revision === initialRevision && result.ok) setState(result.value);
      })
      .catch(() => {});
    return () => {
      current = false;
      unsubscribe();
    };
  }, [api]);
  const check = useCallback(async () => {
    if (!api) return;
    const revision = eventRevision.current;
    try {
      const result = await api.check();
      if (eventRevision.current !== revision) return;
      if (result.ok) setState(result.value);
      else
        setState((old) => ({
          ...old,
          status: "error",
          release: null,
          notification: false,
          message: "检查更新失败，请稍后重试。",
        }));
    } catch {
      if (eventRevision.current !== revision) return;
      setState((old) => ({
        ...old,
        status: "error",
        release: null,
        notification: false,
        message: "检查更新失败，请稍后重试。",
      }));
    }
  }, [api]);
  return { state, check, supported: Boolean(api) };
}
