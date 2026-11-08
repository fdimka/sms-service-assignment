'use strict';

const $ = id => document.getElementById(id);
const employees = [];
let employeeTotal = 0;
let directoryOffset = 0;
let directoryLoading = false;
let contactSaving = false;
let page = 0;
let logLoading = false;
let logRefreshRequested = false;
let pendingIntent = null;
let sampleIndex = 0;
const pageSize = 20;

function identity(employee) {
  return { firstName: employee.firstName, lastName: employee.lastName, address: employee.address };
}

function identityKey(employee) { return JSON.stringify(identity(employee)); }

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.message || 'The request could not be completed.');
    error.status = response.status;
    throw error;
  }
  return result;
}

function feedback(id, text, error = false) {
  const element = $(id);
  element.textContent = text;
  element.className = `feedback ${error ? 'error' : 'success'}`;
}

function option(value, text) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = text;
  return element;
}

function renderEmployees(selectedKey = $('employee').value) {
  const select = $('employee');
  select.replaceChildren(option('', employees.length ? 'Select an employee' : 'Add an employee contact first'));
  for (const employee of employees) {
    select.append(option(identityKey(employee), `${employee.firstName} ${employee.lastName} — ${employee.address}`));
  }
  select.value = selectedKey;
  $('directory-count').textContent = `${employees.length} of ${employeeTotal} employees loaded`;
  $('more-employees').hidden = employees.length >= employeeTotal;
  renderPhones();
}

function renderPhones() {
  const employee = employees.find(item => identityKey(item) === $('employee').value);
  const selected = $('destination').value;
  $('destination').replaceChildren();
  $('destination').disabled = !employee;
  if (!employee) $('destination').append(option('', 'Select an employee first'));
  else {
    for (const phone of employee.phones) $('destination').append(option(phone, phone));
    if (employee.phones.includes(selected)) $('destination').value = selected;
  }
}

async function loadEmployees() {
  if (directoryLoading) return;
  directoryLoading = true;
  $('more-employees').disabled = true;
  $('save-contact').disabled = true;
  try {
    const result = await api(`/employees?limit=100&offset=${directoryOffset}`);
    directoryOffset = result.offset + result.items.length;
    for (const employee of result.items) {
      const existing = employees.findIndex(item => identityKey(item) === identityKey(employee));
      if (existing < 0) employees.push(employee);
      else employees[existing] = employee;
    }
    employeeTotal = result.total;
    renderEmployees();
  } catch (error) {
    feedback('contact-feedback', error.message, true);
  } finally {
    directoryLoading = false;
    $('more-employees').disabled = contactSaving;
    $('save-contact').disabled = contactSaving;
  }
}

$('contact-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('save-contact').disabled) return;
  contactSaving = true;
  $('save-contact').disabled = true;
  $('more-employees').disabled = true;
  const payload = { firstName: $('first-name').value, lastName: $('last-name').value,
    address: $('address').value, phone: $('contact-phone').value };
  try {
    const result = await api('/employees', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const selectedKey = identityKey(result.employee);
    employees.length = 0;
    directoryOffset = 0;
    await loadEmployees();
    // A newly saved contact might sort beyond the first page. It must still be selectable.
    if (!employees.some(item => identityKey(item) === selectedKey)) employees.push(result.employee);
    renderEmployees(selectedKey);
    $('destination').value = payload.phone;
    $('contact-phone').value = '';
    feedback('contact-feedback', result.contactCreated ? 'Contact saved. Ready to send.' : 'This contact is already saved.');
  } catch (error) {
    feedback('contact-feedback', error.message, true);
  } finally {
    contactSaving = false;
    $('save-contact').disabled = false;
    $('more-employees').disabled = false;
  }
});

function updateCount() {
  const length = [...$('message').value].length;
  $('character-count').textContent = `${length} / 160`;
  $('message').setCustomValidity(length > 160 ? 'Use at most 160 characters.'
    : !$('message').value.trim() ? 'Enter a message containing text.' : '');
}

$('message').addEventListener('input', updateCount);
$('employee').addEventListener('change', renderPhones);
$('more-employees').addEventListener('click', loadEmployees);
$('sample-message').addEventListener('click', () => {
  const samples = ['Reminder: the field inspection is scheduled for 09:00.',
    'The irrigation check is complete. Please review the field log.',
    'Please confirm your availability for tomorrow’s team meeting.'];
  $('message').value = samples[sampleIndex++ % samples.length];
  updateCount();
  $('message').focus();
});

$('send-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('send-message').disabled) return;
  updateCount();
  if (!$('send-form').reportValidity()) return;
  const employee = employees.find(item => identityKey(item) === $('employee').value);
  if (!employee) return;
  const payload = { to: $('destination').value, body: $('message').value, employee: identity(employee) };
  const signature = JSON.stringify(payload);
  if (!pendingIntent || pendingIntent.signature !== signature) pendingIntent = { signature, key: crypto.randomUUID() };
  $('send-message').disabled = true;
  try {
    const result = await api('/messages', { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': pendingIntent.key }, body: JSON.stringify(payload) });
    pendingIntent = null;
    $('message').value = '';
    updateCount();
    feedback('send-feedback', `Submission confirmed. Message ID: ${result.id}`);
    page = 0;
    $('status-filter').value = '';
    await refreshLog();
  } catch (error) {
    feedback('send-feedback', error.status ? error.message
      : 'Submission could not be confirmed. Retry unchanged to avoid a duplicate.', true);
  } finally { $('send-message').disabled = false; }
});

function cell(row, text, className = '') {
  const element = document.createElement('td');
  element.textContent = text;
  element.className = className;
  row.append(element);
  return element;
}

function note(parent, text, className = '') {
  const element = document.createElement('small');
  element.textContent = text;
  element.className = className;
  parent.append(element);
}

function renderMessages(messages) {
  const rows = $('message-rows');
  rows.replaceChildren();
  if (!messages.length) {
    const row = document.createElement('tr');
    const empty = cell(row, 'No messages match this view.', 'empty');
    empty.colSpan = 5;
    rows.append(row);
    return;
  }
  for (const message of messages) {
    const row = document.createElement('tr');
    const created = cell(row, new Date(message.createdAt).toLocaleString());
    note(created, message.id, 'message-id');
    const employee = message.employee;
    const employeeCell = cell(row, employee ? `${employee.firstName} ${employee.lastName}` : 'No employee linked');
    if (employee) note(employeeCell, employee.address);
    cell(row, message.to, 'phone');
    const body = cell(row, message.body, 'message-text');
    body.dir = 'auto';
    const statusCell = cell(row, '');
    const badge = document.createElement('span');
    badge.className = `badge ${message.status}`;
    badge.textContent = message.status.charAt(0).toUpperCase() + message.status.slice(1);
    statusCell.append(badge);
    const reasons = { PROVIDER_REJECTED: 'Provider rejected the request.', DELIVERY_FAILED: 'Delivery failed.',
      INTERRUPTED_SEND: 'Send interrupted; outcome uncertain.', SEND_OUTCOME_UNCERTAIN: 'Send outcome uncertain.',
      UNEXPECTED_SEND_RESPONSE: 'Provider response was not recognized.', RECEIPT_NOT_FOUND: 'Delivery receipt was not found.' };
    if (message.errorCode) note(statusCell, reasons[message.errorCode] || 'Outcome needs review.');
    rows.append(row);
  }
}

async function refreshLog() {
  if (logLoading) { logRefreshRequested = true; return; }
  logLoading = true;
  const currentPage = page;
  const currentStatus = $('status-filter').value;
  try {
    const params = new URLSearchParams({ limit: String(pageSize + 1), offset: String(currentPage * pageSize) });
    if (currentStatus) params.set('status', currentStatus);
    const result = await api(`/messages?${params}`);
    if (currentPage !== page || currentStatus !== $('status-filter').value) return;
    renderMessages(result.items.slice(0, pageSize));
    $('previous-page').disabled = page === 0;
    $('next-page').disabled = result.items.length <= pageSize;
    $('page-info').textContent = `Page ${page + 1} · ${Math.min(result.items.length, pageSize)} messages shown`;
    feedback('log-feedback', '');
  } catch (error) { feedback('log-feedback', `Could not refresh the log: ${error.message}`, true); }
  finally {
    logLoading = false;
    if (logRefreshRequested) {
      logRefreshRequested = false;
      void refreshLog();
    }
  }
}

$('refresh-log').addEventListener('click', refreshLog);
$('status-filter').addEventListener('change', () => { page = 0; void refreshLog(); });
$('previous-page').addEventListener('click', () => { page = Math.max(0, page - 1); void refreshLog(); });
$('next-page').addEventListener('click', () => { page++; void refreshLog(); });
setInterval(() => { if ($('auto-refresh').checked) void refreshLog(); }, 2000);
void loadEmployees();
void refreshLog();
