import { useEffect, useState } from "react";

/** Reads only credential presence, never key material or a remote connection. */
export function useModelReadiness(
  profileId: string | undefined,
  local: boolean,
  enabled: boolean,
  refresh: boolean,
) {
  const [verified, setVerified] = useState<{ profileId: string; hasKey: boolean } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Opening/closing configuration explicitly refreshes credential presence.
  useEffect(() => {
    let active = true;
    setVerified(null);
    if (!profileId || local || !enabled) return;
    void window.patentApi.aiCorrection
      .getSettings()
      .then((result) => {
        if (active)
          setVerified({
            profileId,
            hasKey: result.ok && result.value.credentialProfileIds.includes(profileId),
          });
      })
      .catch(() => {
        if (active) setVerified({ profileId, hasKey: false });
      });
    return () => {
      active = false;
    };
  }, [profileId, local, enabled, refresh]);
  return Boolean(
    profileId && enabled && (local || (verified?.profileId === profileId && verified.hasKey)),
  );
}
