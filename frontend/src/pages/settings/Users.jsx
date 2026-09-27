import React, { useState, useEffect } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { useSettings } from '../../context/SettingsContext';

const API_BASE = '/api';

export default function Users() {
  const { t } = useTranslation('users');
  const { token, user } = useAuth();
  const { formatDateTime } = useSettings();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    role: 'viewer'
  });
  const [formError, setFormError] = useState('');
  const [formLoading, setFormLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [userToDelete, setUserToDelete] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [showResetPasswordModal, setShowResetPasswordModal] = useState(false);
  const [userToResetPassword, setUserToResetPassword] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [resetPasswordLoading, setResetPasswordLoading] = useState(false);
  const [resetPasswordError, setResetPasswordError] = useState('');

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch(`${API_BASE}/users`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        if (response.status === 403) {
          throw new Error(t('errors.accessDenied'));
        }
        throw new Error(t('errors.loadFailed'));
      }

      const data = await response.json();
      setUsers(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    setFormError('');
  };

  const handleCreateUser = async (e) => {
    e.preventDefault();
    setFormError('');
    setFormLoading(true);

    // Validation
    if (!formData.name.trim()) {
      setFormError(t('validation.nameRequired'));
      setFormLoading(false);
      return;
    }
    if (!formData.email.trim()) {
      setFormError(t('validation.emailRequired'));
      setFormLoading(false);
      return;
    }
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(formData.email)) {
      setFormError(t('validation.emailInvalid'));
      setFormLoading(false);
      return;
    }
    if (!formData.password || formData.password.length < 8) {
      setFormError(t('validation.passwordMin', { min: 8 }));
      setFormLoading(false);
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/users`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(formData)
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || t('errors.createFailed'));
      }

      // Success - close modal and refresh list
      setShowModal(false);
      setFormData({ name: '', email: '', password: '', role: 'viewer' });
      setSuccessMessage(t('success.created', { name: data.name }));
      setTimeout(() => setSuccessMessage(''), 5000);
      fetchUsers();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setFormLoading(false);
    }
  };

  const handleEditUser = async (e) => {
    e.preventDefault();
    setFormError('');
    setFormLoading(true);

    // Validation
    if (!formData.name.trim()) {
      setFormError(t('validation.nameRequired'));
      setFormLoading(false);
      return;
    }
    if (!formData.email.trim()) {
      setFormError(t('validation.emailRequired'));
      setFormLoading(false);
      return;
    }
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(formData.email)) {
      setFormError(t('validation.emailInvalid'));
      setFormLoading(false);
      return;
    }
    // Password is optional when editing
    if (formData.password && formData.password.length < 8) {
      setFormError(t('validation.passwordMin', { min: 8 }));
      setFormLoading(false);
      return;
    }

    try {
      const payload = {
        name: formData.name,
        email: formData.email,
        role: formData.role
      };
      // Only include password if it was changed
      if (formData.password) {
        payload.password = formData.password;
      }

      const response = await fetch(`${API_BASE}/users/${editingUser.id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || t('errors.updateFailed'));
      }

      // Success - close modal and refresh list
      setShowModal(false);
      setEditingUser(null);
      setFormData({ name: '', email: '', password: '', role: 'viewer' });
      setSuccessMessage(t('success.updated', { name: formData.name }));
      setTimeout(() => setSuccessMessage(''), 5000);
      fetchUsers();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setFormLoading(false);
    }
  };

  const openAddUserModal = () => {
    setEditingUser(null);
    setFormData({ name: '', email: '', password: '', role: 'viewer' });
    setFormError('');
    setShowModal(true);
  };

  const openEditUserModal = (userToEdit) => {
    setEditingUser(userToEdit);
    setFormData({
      name: userToEdit.name,
      email: userToEdit.email,
      password: '',
      role: userToEdit.role
    });
    setFormError('');
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingUser(null);
    setFormData({ name: '', email: '', password: '', role: 'viewer' });
    setFormError('');
  };

  const openDeleteConfirmation = (userToRemove) => {
    setUserToDelete(userToRemove);
    setDeletePassword('');
    setDeleteError('');
    setShowDeleteConfirm(true);
  };

  const closeDeleteConfirmation = () => {
    setShowDeleteConfirm(false);
    setUserToDelete(null);
    setDeletePassword('');
    setDeleteError('');
  };

  const handleDeleteUser = async () => {
    if (!userToDelete) return;

    if (!deletePassword) {
      setDeleteError(t('validation.deletePasswordRequired'));
      return;
    }

    setDeleteLoading(true);
    setDeleteError('');
    try {
      const response = await fetch(`${API_BASE}/users/${userToDelete.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password: deletePassword })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || t('errors.deleteFailed'));
      }

      // Success - close modal and refresh list
      const deletedName = userToDelete.name;
      setShowDeleteConfirm(false);
      setUserToDelete(null);
      setDeletePassword('');
      setSuccessMessage(t('success.deleted', { name: deletedName }));
      setTimeout(() => setSuccessMessage(''), 5000);
      fetchUsers();
    } catch (err) {
      // Keep the modal open so the admin can correct the password
      setDeleteError(err.message);
    } finally {
      setDeleteLoading(false);
    }
  };

  const openResetPasswordModal = (userToReset) => {
    setUserToResetPassword(userToReset);
    setNewPassword('');
    setResetPasswordError('');
    setShowResetPasswordModal(true);
  };

  const closeResetPasswordModal = () => {
    setShowResetPasswordModal(false);
    setUserToResetPassword(null);
    setNewPassword('');
    setResetPasswordError('');
  };

  const handleResetPassword = async () => {
    if (!userToResetPassword) return;

    // Validation
    if (!newPassword) {
      setResetPasswordError(t('validation.passwordRequired'));
      return;
    }
    if (newPassword.length < 8) {
      setResetPasswordError(t('validation.passwordMin', { min: 8 }));
      return;
    }

    setResetPasswordLoading(true);
    setResetPasswordError('');

    try {
      const response = await fetch(`${API_BASE}/users/${userToResetPassword.id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password: newPassword })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || t('errors.resetFailed'));
      }

      // Success - close modal and show message
      setShowResetPasswordModal(false);
      setUserToResetPassword(null);
      setNewPassword('');
      setSuccessMessage(t('success.passwordReset', { name: userToResetPassword.name }));
      setTimeout(() => setSuccessMessage(''), 5000);
    } catch (err) {
      setResetPasswordError(err.message);
    } finally {
      setResetPasswordLoading(false);
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return t('list.neverLoggedIn');
    return formatDateTime(dateString);
  };

  const getRoleBadgeColor = (role) => {
    switch (role) {
      case 'admin':
        return 'bg-red-100 text-red-800';
      case 'operator':
        return 'bg-blue-100 text-blue-800';
      case 'viewer':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
        <span className="ms-2 text-gray-600">{t('loading')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" aria-live="assertive" className="bg-red-50 border border-red-200 rounded-lg p-4">
        <div className="flex">
          <svg className="h-5 w-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div className="ms-3">
            <h3 className="text-sm font-medium text-red-800">{t('common:toast.error')}</h3>
            <p className="mt-1 text-sm text-red-700">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Success Message */}
      {successMessage && (
        <div role="status" aria-live="polite" className="mb-4 bg-green-50 border border-green-200 rounded-lg p-4">
          <div className="flex">
            <svg className="h-5 w-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <p className="ms-3 text-sm text-green-700">{successMessage}</p>
          </div>
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-3 justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{t('header.title')}</h2>
          <p className="text-sm text-gray-500">{t('header.subtitle')}</p>
        </div>
        <button
          onClick={openAddUserModal}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
        >
          <svg className="-ms-1 me-2 h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          {t('header.addUser')}
        </button>
      </div>

      <div className="bg-white shadow-sm rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th scope="col" className="px-6 py-3 text-start text-xs font-medium text-gray-500 uppercase tracking-wider">
                {t('table.name')}
              </th>
              <th scope="col" className="px-6 py-3 text-start text-xs font-medium text-gray-500 uppercase tracking-wider">
                {t('table.email')}
              </th>
              <th scope="col" className="px-6 py-3 text-start text-xs font-medium text-gray-500 uppercase tracking-wider">
                {t('table.role')}
              </th>
              <th scope="col" className="px-6 py-3 text-start text-xs font-medium text-gray-500 uppercase tracking-wider">
                {t('table.lastLogin')}
              </th>
              <th scope="col" className="relative px-6 py-3">
                <span className="sr-only">{t('table.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {users.length === 0 ? (
              <tr>
                <td colSpan="5" className="px-6 py-12 text-center text-gray-500">
                  {t('list.empty')}
                </td>
              </tr>
            ) : (
              users.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <div className="flex-shrink-0 h-10 w-10">
                        <div className="h-10 w-10 rounded-full bg-primary-100 flex items-center justify-center">
                          <span className="text-primary-700 font-medium text-sm">
                            {u.name?.charAt(0)?.toUpperCase() || '?'}
                          </span>
                        </div>
                      </div>
                      <div className="ms-4">
                        <div className="text-sm font-medium text-gray-900" dir="auto">{u.name}</div>
                        {u.id === user?.id && (
                          <span className="text-xs text-gray-400">{t('list.you')}</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-gray-900"><bdi dir="ltr">{u.email}</bdi></div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full capitalize ${getRoleBadgeColor(u.role)}`}>
                      {t(`common:role.${u.role}`, { defaultValue: u.role })}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {formatDate(u.last_login)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-end text-sm font-medium">
                    <button
                      onClick={() => openEditUserModal(u)}
                      className="text-primary-600 hover:text-primary-900 me-3"
                    >
                      {t('common:actions.edit')}
                    </button>
                    {u.id !== user?.id && (
                      <>
                        <button
                          onClick={() => openResetPasswordModal(u)}
                          className="text-amber-600 hover:text-amber-900 me-3"
                        >
                          {t('actions.resetPassword')}
                        </button>
                        <button
                          onClick={() => openDeleteConfirmation(u)}
                          className="text-red-600 hover:text-red-900"
                        >
                          {t('common:actions.delete')}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        </div>
      </div>

      <div className="mt-4 text-sm text-gray-500">
        {t('list.total', { count: users.length })}
      </div>

      {/* Add/Edit User Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto" aria-labelledby="modal-title" role="dialog" aria-modal="true">
          <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            {/* Background overlay */}
            <div
              className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity"
              aria-hidden="true"
              onClick={closeModal}
            ></div>

            {/* Modal panel */}
            <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>
            <div className="inline-block align-bottom bg-white rounded-lg text-start overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full">
              <form onSubmit={editingUser ? handleEditUser : handleCreateUser}>
                <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
                  <div className="sm:flex sm:items-start">
                    <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-primary-100 sm:mx-0 sm:h-10 sm:w-10">
                      <svg className="h-6 w-6 text-primary-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        {editingUser ? (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        ) : (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                        )}
                      </svg>
                    </div>
                    <div className="mt-3 text-center sm:mt-0 sm:ms-4 sm:text-start flex-1">
                      <h3 className="text-lg leading-6 font-medium text-gray-900" id="modal-title">
                        {editingUser ? t('form.editTitle') : t('form.addTitle')}
                      </h3>
                      <p className="mt-1 text-sm text-gray-500">
                        {editingUser
                          ? t('form.editSubtitle')
                          : t('form.addSubtitle')}
                      </p>

                      {formError && (
                        <div role="alert" aria-live="assertive" className="mt-3 bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700">
                          {formError}
                        </div>
                      )}

                      <div className="mt-4 space-y-4">
                        <div>
                          <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                            {t('form.fullName')}
                          </label>
                          <input
                            type="text"
                            name="name"
                            id="name"
                            value={formData.name}
                            onChange={handleInputChange}
                            className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm bg-white text-gray-900 dark:bg-gray-700 dark:text-white"
                            placeholder={t('form.namePlaceholder')}
                          />
                        </div>

                        <div>
                          <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                            {t('form.email')}
                          </label>
                          <input
                            type="email"
                            name="email"
                            id="email"
                            value={formData.email}
                            onChange={handleInputChange}
                            className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm bg-white text-gray-900 dark:bg-gray-700 dark:text-white"
                            placeholder="user@example.com"
                            dir="ltr"
                          />
                        </div>

                        <div>
                          <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                            {t('form.password')} {editingUser && <span className="text-gray-400 font-normal">{t('form.passwordKeepHint')}</span>}
                          </label>
                          <input
                            type="password"
                            name="password"
                            id="password"
                            value={formData.password}
                            onChange={handleInputChange}
                            className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm bg-white text-gray-900 dark:bg-gray-700 dark:text-white"
                            placeholder={editingUser ? t('form.passwordKeepPlaceholder') : t('form.passwordMinPlaceholder', { min: 8 })}
                          />
                        </div>

                        <div>
                          <label htmlFor="role" className="block text-sm font-medium text-gray-700">
                            {t('form.role')}
                          </label>
                          <select
                            name="role"
                            id="role"
                            value={formData.role}
                            onChange={handleInputChange}
                            className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-primary-500 focus:border-primary-500 sm:text-sm bg-white text-gray-900 dark:bg-gray-700 dark:text-white"
                          >
                            <option value="viewer">{t('form.roleOption.viewer')}</option>
                            <option value="operator">{t('form.roleOption.operator')}</option>
                            <option value="admin">{t('form.roleOption.admin')}</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
                  <button
                    type="submit"
                    disabled={formLoading}
                    className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-primary-600 text-base font-medium text-white hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 sm:ms-3 sm:w-auto sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {formLoading ? (
                      <>
                        <svg className="animate-spin -ms-1 me-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        {editingUser ? t('common:actions.saving') : t('form.creating')}
                      </>
                    ) : (
                      editingUser ? t('form.saveChanges') : t('form.createUser')
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={closeModal}
                    className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 sm:mt-0 sm:ms-3 sm:w-auto sm:text-sm"
                  >
                    {t('common:actions.cancel')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && userToDelete && (
        <div className="fixed inset-0 z-50 overflow-y-auto" aria-labelledby="delete-modal-title" role="dialog" aria-modal="true">
          <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            {/* Background overlay */}
            <div
              className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity"
              aria-hidden="true"
              onClick={closeDeleteConfirmation}
            ></div>

            {/* Modal panel */}
            <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>
            <div className="inline-block align-bottom bg-white rounded-lg text-start overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full">
              <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
                <div className="sm:flex sm:items-start">
                  <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-red-100 sm:mx-0 sm:h-10 sm:w-10">
                    <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                  </div>
                  <div className="mt-3 text-center sm:mt-0 sm:ms-4 sm:text-start">
                    <h3 className="text-lg leading-6 font-medium text-gray-900" id="delete-modal-title">
                      {t('delete.title')}
                    </h3>
                    <div className="mt-2">
                      <p className="text-sm text-gray-500">
                        <Trans
                          t={t}
                          i18nKey="delete.body"
                          values={{ name: userToDelete.name, email: userToDelete.email }}
                          components={{ b: <strong dir="auto" />, email: <span dir="ltr" /> }}
                        />
                      </p>
                    </div>

                    {deleteError && (
                      <div role="alert" aria-live="assertive" className="mt-3 bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700">
                        {deleteError}
                      </div>
                    )}

                    <div className="mt-4">
                      <label htmlFor="delete-confirm-password" className="block text-sm font-medium text-gray-700">
                        {t('delete.passwordLabel')}
                      </label>
                      <input
                        type="password"
                        name="delete-confirm-password"
                        id="delete-confirm-password"
                        value={deletePassword}
                        onChange={(e) => {
                          setDeletePassword(e.target.value);
                          setDeleteError('');
                        }}
                        className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-red-500 focus:border-red-500 sm:text-sm bg-white text-gray-900 dark:bg-gray-700 dark:text-white"
                        placeholder={t('delete.passwordPlaceholder')}
                        autoFocus
                      />
                      <p className="mt-1 text-xs text-gray-500">
                        {t('delete.passwordHelp')}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
                <button
                  type="button"
                  onClick={handleDeleteUser}
                  disabled={deleteLoading || !deletePassword}
                  className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-red-600 text-base font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 sm:ms-3 sm:w-auto sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {deleteLoading ? (
                    <>
                      <svg className="animate-spin -ms-1 me-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      {t('delete.deleting')}
                    </>
                  ) : (
                    t('common:actions.delete')
                  )}
                </button>
                <button
                  type="button"
                  onClick={closeDeleteConfirmation}
                  disabled={deleteLoading}
                  className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 sm:mt-0 sm:ms-3 sm:w-auto sm:text-sm disabled:opacity-50"
                >
                  {t('common:actions.cancel')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {showResetPasswordModal && userToResetPassword && (
        <div className="fixed inset-0 z-50 overflow-y-auto" aria-labelledby="reset-password-modal-title" role="dialog" aria-modal="true">
          <div className="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            {/* Background overlay */}
            <div
              className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity"
              aria-hidden="true"
              onClick={closeResetPasswordModal}
            ></div>

            {/* Modal panel */}
            <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>
            <div className="inline-block align-bottom bg-white rounded-lg text-start overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full">
              <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
                <div className="sm:flex sm:items-start">
                  <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-amber-100 sm:mx-0 sm:h-10 sm:w-10">
                    <svg className="h-6 w-6 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                    </svg>
                  </div>
                  <div className="mt-3 text-center sm:mt-0 sm:ms-4 sm:text-start flex-1">
                    <h3 className="text-lg leading-6 font-medium text-gray-900" id="reset-password-modal-title">
                      {t('reset.title')}
                    </h3>
                    <div className="mt-2">
                      <p className="text-sm text-gray-500">
                        <Trans
                          t={t}
                          i18nKey="reset.body"
                          values={{ name: userToResetPassword.name, email: userToResetPassword.email }}
                          components={{ b: <strong dir="auto" />, email: <span dir="ltr" /> }}
                        />
                      </p>
                    </div>

                    {resetPasswordError && (
                      <div role="alert" aria-live="assertive" className="mt-3 bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700">
                        {resetPasswordError}
                      </div>
                    )}

                    <div className="mt-4">
                      <label htmlFor="new-password" className="block text-sm font-medium text-gray-700">
                        {t('reset.newPassword')}
                      </label>
                      <input
                        type="password"
                        name="new-password"
                        id="new-password"
                        value={newPassword}
                        onChange={(e) => {
                          setNewPassword(e.target.value);
                          setResetPasswordError('');
                        }}
                        className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-amber-500 focus:border-amber-500 sm:text-sm bg-white text-gray-900 dark:bg-gray-700 dark:text-white"
                        placeholder={t('form.passwordMinPlaceholder', { min: 8 })}
                        autoFocus
                      />
                      <p className="mt-1 text-xs text-gray-500">
                        {t('reset.help')}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
                <button
                  type="button"
                  onClick={handleResetPassword}
                  disabled={resetPasswordLoading || !newPassword}
                  className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-amber-600 text-base font-medium text-white hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-500 sm:ms-3 sm:w-auto sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {resetPasswordLoading ? (
                    <>
                      <svg className="animate-spin -ms-1 me-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      {t('reset.resetting')}
                    </>
                  ) : (
                    t('reset.submit')
                  )}
                </button>
                <button
                  type="button"
                  onClick={closeResetPasswordModal}
                  disabled={resetPasswordLoading}
                  className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 sm:mt-0 sm:ms-3 sm:w-auto sm:text-sm disabled:opacity-50"
                >
                  {t('common:actions.cancel')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
