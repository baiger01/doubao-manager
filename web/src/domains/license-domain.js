import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

export function useLicenseDomain() {
  const [licenseGate, setLicenseGate] = useState(false);
  const [license, setLicense] = useState(null);

  const refreshLicense = useCallback(async () => {
    try {
      const res = await api.getLicenseStatus();
      if (res.success) {
        const next = res.data || null;
        setLicense(next);
        setLicenseGate(!(next && next.verified));
        return next;
      }
      setLicenseGate(true);
    } catch (e) {
      // 失败时保持当前展示状态，避免短暂网络抖动误关已显示信息。
    }
    return null;
  }, []);

  const activateLicense = useCallback(async (key) => {
    const res = await api.activateLicense(key);
    if (res.success) {
      setLicenseGate(false);
      refreshLicense();
    }
    return res;
  }, [refreshLicense]);

  const verifyLicenseNow = useCallback(async () => {
    const res = await api.verifyLicense();
    await refreshLicense();
    return res;
  }, [refreshLicense]);

  const onLicenseInvalid = useCallback(() => {
    setLicenseGate(true);
    refreshLicense();
  }, [refreshLicense]);

  // 卡密状态轻量轮询(纯展示刷新,不影响门禁):每 5 分钟
  useEffect(() => {
    refreshLicense();
    const t = setInterval(refreshLicense, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [refreshLicense]);

  return {
    licenseGate,
    license,
    refreshLicense,
    activateLicense,
    verifyLicenseNow,
    onLicenseInvalid,
  };
}
