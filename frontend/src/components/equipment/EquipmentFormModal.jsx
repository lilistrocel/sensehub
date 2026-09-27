import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui';
import ErrorMessage from '../ErrorMessage';
import { getUserFriendlyError } from '../../utils/errorHandler';
import ModalShell, { InlineNotice, Spinner } from './ModalShell';
import RegisterMappingEditor from './RegisterMappingEditor';

const API_BASE = '/api';

const EMPTY_FORM = {
  name: '',
  description: '',
  type: '',
  protocol: 'modbus',
  address: '',
  slave_id: '',
  polling_interval_ms: '1000',
  request_gap_ms: '0',
  register_mappings: []
};

const fromEquipment = (equipment) => ({
  name: equipment.name || '',
  description: equipment.description || '',
  type: equipment.type || '',
  protocol: equipment.protocol || 'modbus',
  address: equipment.address || '',
  slave_id: equipment.slave_id !== null && equipment.slave_id !== undefined ? String(equipment.slave_id) : '',
  polling_interval_ms: equipment.polling_interval_ms ? String(equipment.polling_interval_ms) : '1000',
  request_gap_ms: equipment.request_gap_ms ? String(equipment.request_gap_ms) : '0',
  register_mappings: Array.isArray(equipment.register_mappings) ? equipment.register_mappings : []
});

const LABEL = 'block text-sm font-medium text-ink mb-1';

/**
 * Add (equipment == null) or edit (equipment given) an equipment row. One
 * form, one register-mapping editor. Grows to max-w-4xl for Modbus devices so
 * the mapping table fits; the overlay scrolls once (no inner scroll box).
 */
export default function EquipmentFormModal({ isOpen, onClose, onSuccess, token, equipment = null }) {
  const { t } = useTranslation('equipment');
  const isEdit = !!equipment;
  const idp = isEdit ? 'edit-' : 'add-';
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [retryFn, setRetryFn] = useState(null);
  // Synchronous double-submit guard
  const isSubmittingRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    setFormData(equipment ? fromEquipment(equipment) : EMPTY_FORM);
    setError(null);
    setSuccessMessage(null);
    setRetryFn(null);
    isSubmittingRef.current = false;
  }, [isOpen, equipment]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleReset = () => {
    setFormData(EMPTY_FORM);
    setError(null);
    setSuccessMessage(null);
    setRetryFn(null);
  };

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    if (isSubmittingRef.current || saving) return;
    isSubmittingRef.current = true;

    setError(null);
    setSuccessMessage(null);
    setRetryFn(null);

    if (!formData.name.trim()) {
      isSubmittingRef.current = false;
      setError({ message: t('form.nameRequired'), canRetry: false });
      return;
    }

    setSaving(true);
    try {
      const modbusFields = formData.protocol === 'modbus' ? {
        slave_id: formData.slave_id ? parseInt(formData.slave_id, 10) : null,
        polling_interval_ms: formData.polling_interval_ms ? parseInt(formData.polling_interval_ms, 10) : 1000,
        request_gap_ms: formData.request_gap_ms ? parseInt(formData.request_gap_ms, 10) : 0,
        register_mappings: formData.register_mappings.length > 0 ? formData.register_mappings : null
      } : {};

      const response = await fetch(isEdit ? `${API_BASE}/equipment/${equipment.id}` : `${API_BASE}/equipment`, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name.trim(),
          description: formData.description.trim(),
          type: formData.type.trim(),
          protocol: formData.protocol,
          address: formData.address.trim(),
          ...modbusFields
        })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || data.error || (isEdit ? t('form.updateFailed') : t('form.createFailed')));
      }

      const saved = await response.json();
      setSuccessMessage(isEdit ? t('form.updated', { name: saved.name }) : t('form.created', { name: saved.name }));
      if (!isEdit) setFormData(EMPTY_FORM);

      setTimeout(() => {
        onSuccess?.(saved);
        onClose?.();
        setSuccessMessage(null);
      }, 1200);
    } catch (err) {
      const friendly = getUserFriendlyError(err, isEdit ? 'updating equipment' : 'saving equipment');
      setError(friendly);
      if (friendly.canRetry) setRetryFn(() => () => handleSubmit());
    } finally {
      setSaving(false);
      isSubmittingRef.current = false;
    }
  };

  if (!isOpen) return null;
  if (isEdit && !equipment) return null;

  const isModbus = formData.protocol === 'modbus';
  const formId = `${idp}equipment-form`;

  return (
    <ModalShell
      open={isOpen}
      onClose={onClose}
      closeDisabled={saving}
      size={isModbus ? 'xl' : 'md'}
      title={isEdit ? t('form.editTitle') : t('form.addTitle')}
      subtitle={isEdit ? equipment.name : undefined}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>{t('common:actions.cancel')}</Button>
          {!isEdit && <Button variant="secondary" onClick={handleReset} disabled={saving}>{t('common:actions.reset')}</Button>}
          <Button variant="primary" type="submit" form={formId} disabled={saving}>
            {saving ? <><Spinner /> {t('common:actions.saving')}</> : (isEdit ? t('form.saveChanges') : t('form.addTitle'))}
          </Button>
        </>
      )}
    >
      {successMessage && <InlineNotice type="success" className="mb-4">{successMessage}</InlineNotice>}
      {error && (
        <ErrorMessage
          message={typeof error === 'string' ? error : error.message}
          canRetry={error.canRetry}
          onRetry={retryFn}
          isNetworkError={error.isNetworkError}
          className="mb-4"
        />
      )}

      <form id={formId} onSubmit={handleSubmit} className="space-y-4">
        <div className={`grid grid-cols-1 gap-4 ${isModbus ? 'md:grid-cols-2' : ''}`}>
          <div>
            <label htmlFor={`${idp}name`} className={LABEL}>{t('form.name')} <span className="text-alarm-600">*</span></label>
            <input type="text" id={`${idp}name`} name="name" value={formData.name} onChange={handleChange} className="w-full" placeholder={t('form.namePlaceholder')} dir="auto" required />
          </div>
          <div>
            <label htmlFor={`${idp}type`} className={LABEL}>{t('form.type')}</label>
            <input type="text" id={`${idp}type`} name="type" value={formData.type} onChange={handleChange} className="w-full" placeholder={t('form.typePlaceholder')} dir="auto" />
          </div>
          <div className={isModbus ? 'md:col-span-2' : ''}>
            <label htmlFor={`${idp}description`} className={LABEL}>{t('form.description')}</label>
            <textarea id={`${idp}description`} name="description" value={formData.description} onChange={handleChange} rows={2} className="w-full" placeholder={t('form.descriptionPlaceholder')} dir="auto" />
          </div>
          <div>
            <label htmlFor={`${idp}protocol`} className={LABEL}>{t('form.protocol')}</label>
            <select id={`${idp}protocol`} name="protocol" value={formData.protocol} onChange={handleChange} className="w-full">
              <option value="modbus">Modbus</option>
              <option value="mqtt">MQTT</option>
              <option value="zigbee">Zigbee</option>
              <option value="zwave">Z-Wave</option>
              <option value="other">{t('form.protocolOther')}</option>
            </select>
          </div>
          <div>
            <label htmlFor={`${idp}address`} className={LABEL}>{t('form.address')}</label>
            <input type="text" id={`${idp}address`} name="address" value={formData.address} onChange={handleChange} className="w-full font-mono" dir="ltr" placeholder={t('form.addressPlaceholder')} />
          </div>
        </div>

        {isModbus && (
          <div className="border-t border-line pt-4 mt-2">
            <h4 className="font-display text-sm font-semibold text-ink mb-3">{t('form.modbusConfig')}</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div>
                <label htmlFor={`${idp}slave_id`} className={LABEL}>{t('form.slaveId')}</label>
                <input type="number" id={`${idp}slave_id`} name="slave_id" min="1" max="247" value={formData.slave_id} onChange={handleChange} className="w-full font-mono" dir="ltr" placeholder={t('form.slaveIdPlaceholder')} />
              </div>
              <div>
                <label htmlFor={`${idp}polling_interval_ms`} className={LABEL}>{t('form.pollingInterval')}</label>
                <input type="number" id={`${idp}polling_interval_ms`} name="polling_interval_ms" min="100" max="60000" step="100" value={formData.polling_interval_ms} onChange={handleChange} className="w-full font-mono" dir="ltr" placeholder="1000" />
              </div>
              <div>
                <label htmlFor={`${idp}request_gap_ms`} className={LABEL}>{t('form.requestGap')}</label>
                <input type="number" id={`${idp}request_gap_ms`} name="request_gap_ms" min="0" max="5000" step="50" value={formData.request_gap_ms} onChange={handleChange} className="w-full font-mono" dir="ltr" placeholder="0" aria-describedby={`${idp}request_gap_ms-help`} />
                <p id={`${idp}request_gap_ms-help`} className="mt-1 text-xs text-muted">{t('form.requestGapHelp')}</p>
              </div>
            </div>

            <RegisterMappingEditor
              mappings={formData.register_mappings}
              onChange={(next) => setFormData(prev => ({ ...prev, register_mappings: next }))}
              protocol={formData.protocol}
              readOnly={saving}
              name={formData.name}
            />
          </div>
        )}
      </form>
    </ModalShell>
  );
}
