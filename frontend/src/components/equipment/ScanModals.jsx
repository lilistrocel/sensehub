import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, StatusPill } from '../../ui';
import ModalShell, { Spinner } from './ModalShell';

const LABEL = 'block text-xs font-medium text-muted mb-1';

/** Scans for Modbus RTU devices behind a TCP gateway (e.g. USR-DR134). */
export function SlaveIdScannerModal({
  isOpen, onClose, config, onConfigChange, progress, results, selectedSlaves, onSelectedSlavesChange, onScan, onCreateEquipment
}) {
  const { t } = useTranslation('equipment');
  if (!isOpen) return null;

  const isScanning = progress !== null && progress < 100;
  const set = (field, value) => onConfigChange({ ...config, [field]: value });
  const discovered = results?.discovered || [];

  const toggleAll = () => {
    if (discovered.length === 0) return;
    onSelectedSlavesChange(selectedSlaves.length === discovered.length ? [] : discovered.map(d => d.slaveId));
  };
  const toggle = (slaveId) => {
    onSelectedSlavesChange(selectedSlaves.includes(slaveId) ? selectedSlaves.filter(id => id !== slaveId) : [...selectedSlaves, slaveId]);
  };

  return (
    <ModalShell
      open={isOpen}
      onClose={onClose}
      closeDisabled={isScanning}
      size="xl"
      title={t('scan.slaveTitle')}
      subtitle={t('scan.slaveSubtitle')}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={isScanning}>{t('common:actions.close')}</Button>
          {discovered.length > 0 && selectedSlaves.length > 0 && (
            <Button variant="secondary" onClick={onCreateEquipment}>
              {t('scan.addDevices', { count: selectedSlaves.length })}
            </Button>
          )}
          <Button variant="primary" onClick={onScan} disabled={isScanning || !config.host}>
            {isScanning ? <><Spinner /> {t('scan.scanning')}</> : t('scan.start')}
          </Button>
        </>
      )}
    >
      <div className="mb-5">
        <h4 className="font-display text-sm font-semibold text-ink mb-3">{t('scan.config')}</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          <div>
            <label htmlFor="scan-host" className={LABEL}>{t('scan.host')}</label>
            <input type="text" id="scan-host" value={config.host} onChange={(e) => set('host', e.target.value)} placeholder="192.168.1.100" disabled={isScanning} className="w-full font-mono" dir="ltr" />
          </div>
          <div>
            <label htmlFor="scan-port" className={LABEL}>{t('scan.port')}</label>
            <input type="number" id="scan-port" value={config.port} onChange={(e) => set('port', e.target.value)} placeholder="502" min="1" max="65535" disabled={isScanning} className="w-full font-mono" dir="ltr" />
          </div>
          <div>
            <label htmlFor="scan-timeout" className={LABEL}>{t('scan.timeout')}</label>
            <input type="number" id="scan-timeout" value={config.timeout} onChange={(e) => set('timeout', e.target.value)} placeholder="500" min="100" max="5000" disabled={isScanning} className="w-full font-mono" dir="ltr" />
          </div>
          <div>
            <label htmlFor="scan-start" className={LABEL}>{t('scan.startId')}</label>
            <input type="number" id="scan-start" value={config.startSlaveId} onChange={(e) => set('startSlaveId', e.target.value)} placeholder="1" min="1" max="247" disabled={isScanning} className="w-full font-mono" dir="ltr" />
          </div>
          <div>
            <label htmlFor="scan-end" className={LABEL}>{t('scan.endId')}</label>
            <input type="number" id="scan-end" value={config.endSlaveId} onChange={(e) => set('endSlaveId', e.target.value)} placeholder="247" min="1" max="247" disabled={isScanning} className="w-full font-mono" dir="ltr" />
          </div>
        </div>
        <p className="mt-2 text-xs text-muted">{t('scan.help')}</p>
      </div>

      {progress !== null && (
        <div className="mb-5">
          <div className="flex items-center justify-between mb-1.5 text-sm">
            <span className="font-medium text-ink">{isScanning ? t('scan.scanning') : t('scan.complete')}</span>
            <span className="font-mono tabular text-muted">{Math.round(progress)}%</span>
          </div>
          <div className="w-full bg-field rounded-full h-2 border border-line">
            <div className={`h-full rounded-full transition-all duration-300 ${isScanning ? 'bg-brand-600' : 'bg-state-ok'}`} style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {results && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="font-display text-sm font-semibold text-ink">{t('scan.discovered', { count: discovered.length })}</h4>
            {discovered.length > 0 && (
              <Button variant="ghost" size="sm" onClick={toggleAll}>{selectedSlaves.length === discovered.length ? t('scan.deselectAll') : t('scan.selectAll')}</Button>
            )}
          </div>
          {discovered.length === 0 ? (
            <Card padding="lg" className="text-center">
              <p className="text-sm text-muted">{t('scan.noneFound')}</p>
            </Card>
          ) : (
            <ul className="space-y-2">
              {discovered.map((device) => {
                const selected = selectedSlaves.includes(device.slaveId);
                return (
                  <li key={device.slaveId}>
                    <label className={`flex items-start gap-3 p-3 rounded-card border cursor-pointer min-h-touch ${selected ? 'border-brand-500 bg-brand-50/60 dark:bg-brand-900/20' : 'border-line bg-panel hover:bg-field'}`}>
                      <input type="checkbox" checked={selected} onChange={() => toggle(device.slaveId)} className="h-4 w-4 mt-1" aria-label={t('scan.selectSlave', { id: device.slaveId })} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-mono font-semibold text-ink">{t('scan.slave', { id: device.slaveId })}</span>
                          <span className="font-mono text-xs text-muted">{device.responseTime} ms</span>
                        </div>
                        {Array.isArray(device.functionCodes) && device.functionCodes.length > 0 ? (
                          <div className="mt-1 flex flex-col gap-1">
                            {device.functionCodes.map((fc) => (
                              <div key={`${device.slaveId}-${fc.fc}-${fc.address}`} className="flex flex-wrap items-center gap-2 text-xs">
                                <span className="inline-flex items-center rounded border border-line bg-field px-1.5 font-mono text-ink">{fc.fc}</span>
                                <span className="text-muted">{fc.label} @{fc.address}</span>
                                <span className="font-mono text-muted">{Array.isArray(fc.sample) ? `[${fc.sample.slice(0, 4).join(', ')}]` : String(fc.sample)}</span>
                              </div>
                            ))}
                          </div>
                        ) : device.sampleData ? (
                          <p className="mt-1 text-xs font-mono text-muted">{`[${device.sampleData.slice(0, 3).join(', ')}…]`}</p>
                        ) : (
                          <p className="mt-1 text-xs text-muted">{t('scan.noRegisters')}</p>
                        )}
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </ModalShell>
  );
}

/** Devices found during a Modbus TCP network scan. */
export function DiscoveredDevicesModal({ isOpen, onClose, devices, onAddDevice, addingDevice }) {
  const { t } = useTranslation('equipment');
  if (!isOpen) return null;

  return (
    <ModalShell
      open={isOpen}
      onClose={onClose}
      size="lg"
      title={t('scan.tcpTitle')}
      subtitle={devices.length === 0 ? undefined : t('scan.tcpSubtitle', { count: devices.length })}
      footer={<Button variant="secondary" onClick={onClose}>{t('common:actions.close')}</Button>}
    >
      {devices.length === 0 ? (
        <p className="text-center text-muted py-8 text-sm">{t('scan.tcpNone')}</p>
      ) : (
        <ul className="space-y-3">
          {devices.map((device) => (
            <Card as="li" key={device.address} padding="md" className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h4 dir="auto" className="font-medium text-ink truncate">{device.suggestedName}</h4>
                <p className="text-sm text-muted mt-0.5 font-mono">{device.address}</p>
                {device.deviceInfo && Object.keys(device.deviceInfo).length > 0 && (
                  <div className="mt-1 text-xs text-muted">
                    {device.deviceInfo.VendorName && <p>{t('scan.vendor', { value: device.deviceInfo.VendorName })}</p>}
                    {device.deviceInfo.ProductName && <p>{t('scan.product', { value: device.deviceInfo.ProductName })}</p>}
                    {device.deviceInfo.MajorMinorRevision && <p>{t('scan.version', { value: device.deviceInfo.MajorMinorRevision })}</p>}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <StatusPill state={device.responsive ? 'ok' : 'idle'} filled={!!device.responsive} text={device.responsive ? t('scan.responsive') : t('scan.detected')} />
                  <span className="inline-flex items-center rounded border border-line bg-field px-1.5 py-0.5 text-xs font-mono text-muted">{t('scan.portN', { port: device.port })}</span>
                </div>
              </div>
              <Button variant="primary" onClick={() => onAddDevice(device)} disabled={addingDevice === device.address} className="shrink-0">
                {addingDevice === device.address ? <><Spinner /> {t('scan.adding')}</> : t('common:actions.add')}
              </Button>
            </Card>
          ))}
        </ul>
      )}
    </ModalShell>
  );
}
