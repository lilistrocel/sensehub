import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useWebSocket } from '../context/WebSocketContext';
import { useBreadcrumb } from '../components/Breadcrumb';
import { useSettings } from '../context/SettingsContext';
import { useToast } from '../context/ToastContext';
import ConfirmDialog from '../components/ConfirmDialog';
import { Button, Card, StatusPill } from '../ui';
import EquipmentList from '../components/equipment/EquipmentList';
import EquipmentDetailModal from '../components/equipment/EquipmentDetailModal';
import EquipmentFormModal from '../components/equipment/EquipmentFormModal';
import RelayControlModal from '../components/equipment/RelayControlModal';
import { SlaveIdScannerModal, DiscoveredDevicesModal } from '../components/equipment/ScanModals';
import { InlineNotice, Spinner } from '../components/equipment/ModalShell';
import { useNow } from '../components/equipment/equipmentStatus';
import { toEpochMs } from '../utils/freshness';

const API_BASE = '/api';

export default function Equipment() {
  const { token, user } = useAuth();
  const { subscribe, connected } = useWebSocket();
  const { showError, showSuccess } = useToast();
  const { formatDateTime, formatTime } = useSettings();
  const { id: urlEquipmentId } = useParams();
  const navigate = useNavigate();
  const { setCustomSegment } = useBreadcrumb();
  const now = useNow(30000);

  const [equipment, setEquipment] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedEquipment, setSelectedEquipment] = useState(null);
  const [equipmentToDelete, setEquipmentToDelete] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [sortColumn, setSortColumn] = useState('name');
  const [sortDirection, setSortDirection] = useState('asc');
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [discoveredDevices, setDiscoveredDevices] = useState([]);
  const [showDiscoveredModal, setShowDiscoveredModal] = useState(false);
  const [showSlaveScanner, setShowSlaveScanner] = useState(false);
  const [slaveScanConfig, setSlaveScanConfig] = useState({ host: '', port: '502', startSlaveId: '1', endSlaveId: '247', timeout: '500' });
  const [slaveScanProgress, setSlaveScanProgress] = useState(null);
  const [slaveScanResults, setSlaveScanResults] = useState(null);
  const [selectedSlaves, setSelectedSlaves] = useState([]);
  const [addingDevice, setAddingDevice] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [showRelayControl, setShowRelayControl] = useState(false);
  const [relayControlEquipment, setRelayControlEquipment] = useState(null);
  const [equipmentNotFound, setEquipmentNotFound] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);

  const authHeaders = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const formatSinceFn = (d, sameDay) => (sameDay ? formatTime(d) : formatDateTime(d));

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Breadcrumb shows the open equipment's name
  useEffect(() => {
    if (selectedEquipment && showDetailModal) setCustomSegment(selectedEquipment.name);
    else setCustomSegment(null);
    return () => setCustomSegment(null);
  }, [selectedEquipment, showDetailModal, setCustomSegment]);

  // Deep link: /equipment/:id opens the detail modal
  useEffect(() => {
    if (urlEquipmentId && equipment.length > 0 && !loading) {
      const eq = equipment.find(e => e.id === parseInt(urlEquipmentId, 10));
      if (eq) {
        setSelectedEquipment(eq);
        setShowDetailModal(true);
        setEquipmentNotFound(false);
      } else {
        setEquipmentNotFound(true);
        setShowDetailModal(false);
        setSelectedEquipment(null);
      }
    } else if (!urlEquipmentId) {
      setEquipmentNotFound(false);
    }
  }, [urlEquipmentId, equipment, loading]);

  // Live updates
  useEffect(() => {
    const touch = () => setLastUpdate(new Date().toISOString());
    const unsubUpdate = subscribe('equipment_updated', (data) => {
      setEquipment(prev => prev.map(eq => (eq.id === data.id ? { ...eq, ...data } : eq)));
      touch();
    });
    const unsubCreate = subscribe('equipment_created', (data) => {
      setEquipment(prev => [...prev, { ...data, zones: [] }]);
      touch();
    });
    const unsubDelete = subscribe('equipment_deleted', (data) => {
      setEquipment(prev => prev.filter(eq => eq.id !== data.id));
      touch();
    });
    const unsubControl = subscribe('equipment_control', (data) => {
      setEquipment(prev => prev.map(eq => {
        if (eq.id !== data.id) return eq;
        const newStatus = data.action === 'on' ? 'online' : data.action === 'off' ? 'offline' : eq.status;
        return { ...eq, status: newStatus };
      }));
      touch();
    });
    const unsubStatus = subscribe('equipment_status', (data) => {
      setEquipment(prev => prev.map(eq => (eq.id === data.id ? { ...eq, status: data.status, last_reading: data.last_reading } : eq)));
      touch();
    });
    // Poll read-backs and relay writes refresh last_communication so the
    // "not reported since" evaluation tracks the device, not the page load.
    const unsubReading = subscribe('equipment_reading', (data) => {
      const id = data?.equipment_id ?? data?.equipmentId ?? data?.id;
      if (id === undefined || id === null) return;
      const ts = data.timestamp || new Date().toISOString();
      setEquipment(prev => prev.map(eq => (eq.id === id ? { ...eq, last_communication: ts, status: eq.status === 'offline' ? 'online' : eq.status } : eq)));
    });
    const unsubRelay = subscribe('relay_state_changed', (data) => {
      const id = data?.equipmentId ?? data?.equipment_id;
      if (id === undefined || id === null) return;
      setEquipment(prev => prev.map(eq => {
        if (eq.id !== id) return eq;
        const next = { ...eq, last_communication: data.timestamp || new Date().toISOString() };
        if (data.relayStates) next.last_reading = JSON.stringify({ relayStates: data.relayStates });
        return next;
      }));
    });
    return () => {
      unsubUpdate(); unsubCreate(); unsubDelete(); unsubControl(); unsubStatus(); unsubReading(); unsubRelay();
    };
  }, [subscribe]);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);
      const equipmentResponse = await fetch(`${API_BASE}/equipment`, { headers: authHeaders });
      if (!equipmentResponse.ok) throw new Error('Failed to fetch equipment');
      const equipmentData = await equipmentResponse.json();
      setEquipment(equipmentData);

      // Zone assignments come from the per-equipment detail endpoint
      const equipmentWithZones = await Promise.all(
        equipmentData.map(async (eq) => {
          try {
            const detailResponse = await fetch(`${API_BASE}/equipment/${eq.id}`, { headers: authHeaders });
            if (detailResponse.ok) {
              const detailData = await detailResponse.json();
              return { ...eq, zones: detailData.zones || [] };
            }
          } catch {
            // ignore individual fetch errors
          }
          return { ...eq, zones: [] };
        })
      );
      setEquipment(equipmentWithZones);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleExportCSV = () => {
    const headers = ['ID', 'Name', 'Description', 'Type', 'Protocol', 'Address', 'Status', 'Enabled', 'Last Reading', 'Last Communication', 'Zones', 'Created At', 'Updated At'];
    const rows = equipment.map(eq => [
      eq.id, eq.name || '', eq.description || '', eq.type || '', eq.protocol || '', eq.address || '', eq.status || '',
      eq.enabled ? 'Yes' : 'No', eq.last_reading || '', eq.last_communication || '',
      eq.zones ? eq.zones.map(z => z.name).join('; ') : '', eq.created_at || '', eq.updated_at || ''
    ]);
    const esc = (value) => {
      if (value === null || value === undefined) return '';
      const str = String(value);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const csv = [headers.map(esc).join(','), ...rows.map(row => row.map(esc).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = `equipment-export-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleScan = async () => {
    setScanning(true);
    setScanResult(null);
    setDiscoveredDevices([]);
    try {
      const response = await fetch(`${API_BASE}/equipment/scan`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ scanType: 'network' }) });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || 'Scan failed');
      }
      const data = await response.json();
      const discovered = data.discovered || [];
      setScanResult({ type: 'success', message: data.message, discovered, totalFound: data.totalFound || 0, existingDevicesFound: data.existingDevicesFound || 0 });
      if (discovered.length > 0) {
        setDiscoveredDevices(discovered);
        setShowDiscoveredModal(true);
      }
      await fetchData();
      if (discovered.length === 0) setTimeout(() => setScanResult(null), 5000);
    } catch (err) {
      setScanResult({ type: 'error', message: err.message });
      setTimeout(() => setScanResult(null), 5000);
    } finally {
      setScanning(false);
    }
  };

  const handleSlaveScan = async () => {
    setSlaveScanProgress(0);
    setSlaveScanResults(null);
    setSelectedSlaves([]);
    // No streaming from the scan route: tick a progress bar while it runs.
    const progressInterval = setInterval(() => setSlaveScanProgress(prev => Math.min((prev ?? 0) + 5, 95)), 500);
    try {
      const response = await fetch(`${API_BASE}/equipment/scan-slaves`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({
          host: slaveScanConfig.host,
          port: parseInt(slaveScanConfig.port, 10) || 502,
          startSlaveId: parseInt(slaveScanConfig.startSlaveId, 10) || 1,
          endSlaveId: parseInt(slaveScanConfig.endSlaveId, 10) || 247,
          timeout: parseInt(slaveScanConfig.timeout, 10) || 500
        })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || 'Slave scan failed');
      }
      const data = await response.json();
      setSlaveScanProgress(100);
      setSlaveScanResults(data);
      if (data.discovered && data.discovered.length > 0) setSelectedSlaves(data.discovered.map(d => d.slaveId));
    } catch (err) {
      setSlaveScanProgress(null);
      showError(`Scan failed: ${err.message}`);
    } finally {
      clearInterval(progressInterval);
    }
  };

  const handleCreateSlavesAsEquipment = async () => {
    if (selectedSlaves.length === 0) return;
    try {
      const response = await fetch(`${API_BASE}/equipment/scan-slaves/create-bulk`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({
          host: slaveScanConfig.host,
          port: parseInt(slaveScanConfig.port, 10) || 502,
          slaves: selectedSlaves.map(slaveId => {
            const discovered = slaveScanResults?.discovered?.find(d => d.slaveId === slaveId);
            return { slaveId, functionCodes: discovered?.functionCodes };
          }),
          namePrefix: 'Modbus Device'
        })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to create equipment');
      }
      const data = await response.json();
      showSuccess(`Created ${data.count} equipment entries`);
      setShowSlaveScanner(false);
      setSlaveScanProgress(null);
      setSlaveScanResults(null);
      setSelectedSlaves([]);
      await fetchData();
    } catch (err) {
      showError(`Failed to create equipment: ${err.message}`);
    }
  };

  const handleAddDiscoveredDevice = async (device) => {
    setAddingDevice(device.address);
    try {
      const response = await fetch(`${API_BASE}/equipment`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({
          name: device.suggestedName || `Modbus Device (${device.ip})`,
          description: device.deviceInfo?.ProductName
            ? `${device.deviceInfo.VendorName || ''} ${device.deviceInfo.ProductName}`.trim()
            : `Discovered Modbus TCP device at ${device.address}`,
          type: 'sensor',
          protocol: 'modbus',
          address: device.address
        })
      });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.message || 'Failed to add device');
      }
      setDiscoveredDevices(prev => prev.filter(d => d.address !== device.address));
      await fetchData();
      if (discoveredDevices.length <= 1) {
        setShowDiscoveredModal(false);
        setScanResult(null);
      }
    } catch (err) {
      showError(`Failed to add device: ${err.message}`);
    } finally {
      setAddingDevice(null);
    }
  };

  const handleViewEquipment = (eq) => {
    setSelectedEquipment(eq);
    setShowDetailModal(true);
    navigate(`/equipment/${eq.id}`, { replace: true });
  };

  const handleCloseDetailModal = () => {
    setShowDetailModal(false);
    setSelectedEquipment(null);
    navigate('/equipment', { replace: true });
  };

  const handleEditEquipment = (eq) => {
    setSelectedEquipment(eq);
    setShowEditModal(true);
  };

  const handleOpenRelays = (eq) => {
    setRelayControlEquipment(eq);
    setShowRelayControl(true);
  };

  const handleDeleteEquipment = async () => {
    if (!equipmentToDelete) return;
    setDeleteLoading(true);
    try {
      const response = await fetch(`${API_BASE}/equipment/${equipmentToDelete.id}`, { method: 'DELETE', headers: authHeaders });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to delete equipment');
      }
      showSuccess(`"${equipmentToDelete.name}" deleted`);
      setEquipmentToDelete(null);
      fetchData();
    } catch (err) {
      showError(err.message, 'Delete failed');
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleSort = (column) => {
    if (sortColumn === column) setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const filteredEquipment = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const list = equipment.filter(eq => {
      const matchesSearch = !term
        || eq.name?.toLowerCase().includes(term)
        || eq.type?.toLowerCase().includes(term)
        || eq.description?.toLowerCase().includes(term);
      const isDisabled = eq.enabled === 0 || eq.enabled === false;
      const matchesStatus = !statusFilter
        || (statusFilter === 'disabled' ? isDisabled : (!isDisabled && eq.status === statusFilter));
      return matchesSearch && matchesStatus;
    });
    const dir = sortDirection === 'asc' ? 1 : -1;
    return list.sort((a, b) => {
      if (sortColumn === 'last_seen') {
        const av = toEpochMs(a.last_communication) ?? -Infinity;
        const bv = toEpochMs(b.last_communication) ?? -Infinity;
        return (av - bv) * dir;
      }
      const pick = (e) => {
        switch (sortColumn) {
          case 'type': return (e.type || '').toLowerCase();
          case 'status': return (e.status || '').toLowerCase();
          case 'zone': return (e.zones && e.zones.length > 0 ? e.zones[0].name : '').toLowerCase();
          default: return (e.name || '').toLowerCase();
        }
      };
      const av = pick(a), bv = pick(b);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return 0;
    });
  }, [equipment, searchTerm, statusFilter, sortColumn, sortDirection]);

  const totalPages = Math.ceil(filteredEquipment.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedEquipment = filteredEquipment.slice(startIndex, endIndex);

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(filteredEquipment.length / itemsPerPage));
    if (currentPage > maxPage) setCurrentPage(maxPage);
  }, [filteredEquipment.length, itemsPerPage, currentPage]);

  useEffect(() => { setCurrentPage(1); }, [searchTerm, statusFilter]);

  const goToPage = (page) => setCurrentPage(Math.min(Math.max(1, page), Math.max(1, totalPages)));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted">
        <Spinner className="h-6 w-6" />
        <span className="ml-3">Loading equipment…</span>
      </div>
    );
  }

  if (error) {
    return (
      <InlineNotice type="error">
        {error}
        <button type="button" onClick={fetchData} className="ml-2 underline font-semibold">Try again</button>
      </InlineNotice>
    );
  }

  if (equipmentNotFound) {
    return (
      <Card rail="caution" padding="lg" className="max-w-lg mx-auto mt-12 text-center">
        <h2 className="font-display text-xl font-semibold text-ink mb-2">Equipment not found</h2>
        <p className="text-muted mb-4">The equipment with ID "{urlEquipmentId}" does not exist or may have been deleted.</p>
        <Button variant="primary" onClick={() => navigate('/equipment')}>Back to equipment list</Button>
      </Card>
    );
  }

  const pageNumbers = Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
    if (totalPages <= 5) return i + 1;
    if (currentPage <= 3) return i + 1;
    if (currentPage >= totalPages - 2) return totalPages - 4 + i;
    return currentPage - 2 + i;
  }).filter(n => n >= 1 && n <= totalPages);

  return (
    <div>
      {/* Header: one primary (Add); scans are secondary; export is ghost */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <h1 className="font-display text-2xl font-semibold text-ink">Equipment</h1>
        <div className="flex flex-wrap gap-2 w-full sm:w-auto">
          <Button variant="secondary" onClick={handleScan} disabled={scanning} title="Scan the LAN for Modbus TCP devices">
            {scanning ? <Spinner /> : (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            )}
            <span className="hidden sm:inline">{scanning ? 'Scanning…' : 'Scan network'}</span>
            <span className="sm:hidden">{scanning ? 'Scan…' : 'Scan'}</span>
          </Button>
          <Button variant="secondary" onClick={() => setShowSlaveScanner(true)} title="Probe slave IDs on an RS485 gateway">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
            </svg>
            <span className="hidden sm:inline">Scan slaves</span>
            <span className="sm:hidden">Slaves</span>
          </Button>
          <Button variant="primary" onClick={() => setShowAddModal(true)}>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add
          </Button>
          <Button variant="ghost" onClick={handleExportCSV} disabled={equipment.length === 0} title="Export equipment to CSV">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            <span className="hidden sm:inline">Export</span>
            <span className="sm:hidden">CSV</span>
          </Button>
        </div>
      </div>

      {scanResult && (
        <InlineNotice type={scanResult.type === 'success' ? 'success' : 'error'} className="mb-6">
          {scanResult.message}
          {scanResult.discovered && scanResult.discovered.length > 0 && <span className="ml-2">({scanResult.discovered.length} devices found)</span>}
          {scanResult.discovered && scanResult.discovered.length === 0 && scanResult.type === 'success' && <span className="ml-2">(No new devices found)</span>}
        </InlineNotice>
      )}

      {/* Filters */}
      <Card padding="md" className="mb-6">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1">
            <label htmlFor="search" className="sr-only">Search equipment</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <svg className="h-5 w-5 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <input
                type="search"
                id="search"
                className="w-full !pl-10 min-h-touch"
                placeholder="Search by name, type, or description…"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>
          <div className="sm:w-48">
            <label htmlFor="status-filter" className="sr-only">Filter by status</label>
            <select id="status-filter" className="w-full min-h-touch" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
              <option value="warning">Warning</option>
              <option value="error">Error</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
          {(searchTerm || statusFilter) && (
            <Button variant="ghost" onClick={() => { setSearchTerm(''); setStatusFilter(''); }}>Clear filters</Button>
          )}
        </div>
      </Card>

      {/* List */}
      {filteredEquipment.length === 0 ? (
        <Card padding="lg" className="text-center py-12">
          <h3 className="font-display text-base font-semibold text-ink">No equipment</h3>
          <p className="mt-1 text-sm text-muted">
            {equipment.length === 0 ? 'Get started by adding your first piece of equipment.' : 'No equipment matches your current filters.'}
          </p>
          {equipment.length === 0 && (
            <div className="mt-6"><Button variant="primary" onClick={() => setShowAddModal(true)}>Add equipment</Button></div>
          )}
        </Card>
      ) : (
        <EquipmentList
          items={paginatedEquipment}
          user={user}
          now={now}
          formatSinceFn={formatSinceFn}
          formatDateTime={formatDateTime}
          sortColumn={sortColumn}
          sortDirection={sortDirection}
          onSort={handleSort}
          onView={handleViewEquipment}
          onEdit={handleEditEquipment}
          onDelete={setEquipmentToDelete}
          onRelays={handleOpenRelays}
        />
      )}

      {/* Pagination + live status */}
      {filteredEquipment.length > 0 && (
        <Card padding="md" className="mt-4">
          <div className="flex flex-col md:flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-muted">
              <label htmlFor="items-per-page">Show</label>
              <select id="items-per-page" value={itemsPerPage} onChange={(e) => { setItemsPerPage(Number(e.target.value)); setCurrentPage(1); }} className="!py-1.5 min-h-[36px]">
                <option value={5}>5</option>
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
              </select>
              <span>per page</span>
            </div>
            <div className="text-sm text-muted font-mono tabular">
              {startIndex + 1}–{Math.min(endIndex, filteredEquipment.length)} of {filteredEquipment.length}
              {equipment.length !== filteredEquipment.length && <span> (filtered from {equipment.length})</span>}
            </div>
            <nav className="flex items-center gap-1" aria-label="Pagination">
              <Button variant="ghost" size="sm" onClick={() => goToPage(1)} disabled={currentPage === 1} title="First page" aria-label="First page">«</Button>
              <Button variant="ghost" size="sm" onClick={() => goToPage(currentPage - 1)} disabled={currentPage === 1} title="Previous page">‹ Prev</Button>
              {pageNumbers.map(n => (
                <Button key={n} variant={currentPage === n ? 'primary' : 'ghost'} size="sm" onClick={() => goToPage(n)} aria-current={currentPage === n ? 'page' : undefined}>{n}</Button>
              ))}
              <Button variant="ghost" size="sm" onClick={() => goToPage(currentPage + 1)} disabled={currentPage === totalPages || totalPages === 0} title="Next page">Next ›</Button>
              <Button variant="ghost" size="sm" onClick={() => goToPage(totalPages)} disabled={currentPage === totalPages || totalPages === 0} title="Last page" aria-label="Last page">»</Button>
            </nav>
          </div>
          <div className="mt-3 pt-3 border-t border-line flex items-center justify-between gap-3 text-xs">
            <StatusPill state={connected ? 'ok' : 'idle'} filled={connected} pulse={connected} text={connected ? 'Live updates' : 'Live updates disconnected'} />
            {lastUpdate && <span className="text-muted font-mono tabular">Last update {formatDateTime(lastUpdate)}</span>}
          </div>
        </Card>
      )}

      <EquipmentFormModal isOpen={showAddModal} onClose={() => setShowAddModal(false)} onSuccess={fetchData} token={token} />

      <EquipmentDetailModal
        isOpen={showDetailModal}
        onClose={handleCloseDetailModal}
        equipment={selectedEquipment}
        token={token}
        onUpdate={fetchData}
        user={user}
      />

      <EquipmentFormModal
        isOpen={showEditModal}
        onClose={() => { setShowEditModal(false); setSelectedEquipment(null); }}
        equipment={selectedEquipment}
        onSuccess={fetchData}
        token={token}
      />

      <ConfirmDialog
        open={equipmentToDelete !== null}
        title="Delete equipment?"
        body={(
          <>
            <strong>{equipmentToDelete?.name}</strong> will be removed along with its readings, zone assignments and relay history. This cannot be undone.
          </>
        )}
        variant="danger"
        confirmLabel="Delete"
        busy={deleteLoading}
        onCancel={() => { if (!deleteLoading) setEquipmentToDelete(null); }}
        onConfirm={handleDeleteEquipment}
      />

      <DiscoveredDevicesModal
        isOpen={showDiscoveredModal}
        onClose={() => { setShowDiscoveredModal(false); setScanResult(null); }}
        devices={discoveredDevices}
        onAddDevice={handleAddDiscoveredDevice}
        addingDevice={addingDevice}
      />

      <SlaveIdScannerModal
        isOpen={showSlaveScanner}
        onClose={() => { setShowSlaveScanner(false); setSlaveScanProgress(null); setSlaveScanResults(null); setSelectedSlaves([]); }}
        config={slaveScanConfig}
        onConfigChange={setSlaveScanConfig}
        progress={slaveScanProgress}
        results={slaveScanResults}
        selectedSlaves={selectedSlaves}
        onSelectedSlavesChange={setSelectedSlaves}
        onScan={handleSlaveScan}
        onCreateEquipment={handleCreateSlavesAsEquipment}
      />

      <RelayControlModal
        isOpen={showRelayControl}
        onClose={() => { setShowRelayControl(false); setRelayControlEquipment(null); }}
        equipment={relayControlEquipment}
        token={token}
        user={user}
        onUpdate={fetchData}
      />
    </div>
  );
}
