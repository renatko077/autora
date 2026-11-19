const $ = (selector) => document.querySelector(selector);

const state = { orders: [], statement: null, loading: false };
const statusLabels = {
  awaiting_payment: 'Очікує оплату',
  paid: 'Оплачено',
  processing: 'В обробці',
  shipped: 'Відправлено',
  cancelled: 'Скасовано'
};

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function formatMoney(value, decimals = 0) {
  return `${new Intl.NumberFormat('uk-UA', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value)} ₴`;
}

function kyivDateKey(value) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(value));
  const date = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${date.year}-${date.month}-${date.day}`;
}

function statementDateKey(value) {
  const [day, month, year] = value.split('.');
  return `${year}-${month}-${day}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', day: '2-digit', month: 'short', year: 'numeric'
  }).format(new Date(value));
}

function formatTime(value) {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit'
  }).format(new Date(value));
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Сталася помилка.'), { status: response.status });
  return data;
}

function showNotice(message, error = false) {
  const notice = $('#ordersNotice');
  notice.textContent = message;
  notice.classList.toggle('is-error', error);
  notice.hidden = false;
  if (!error) window.setTimeout(() => { notice.hidden = true; }, 3600);
}

function filteredOrders() {
  const query = $('#searchInput').value.trim().toLocaleLowerCase('uk');
  const selectedStatus = $('#statusFilter').value;
  const fromDate = $('#fromDate').value;
  const toDate = $('#toDate').value;
  return state.orders.filter((order) => {
    const dateKey = kyivDateKey(order.createdAt);
    if (selectedStatus !== 'all' && order.status !== selectedStatus) return false;
    if (fromDate && dateKey < fromDate) return false;
    if (toDate && dateKey > toDate) return false;
    if (!query) return true;
    const text = [order.reference, order.name, order.phone, order.delivery, ...order.items.map((item) => item.name)]
      .join(' ').toLocaleLowerCase('uk');
    return text.includes(query);
  });
}

function statementTransactions() {
  return state.statement?.transactions || [];
}

function filteredStatement() {
  const query = $('#statementSearch').value.trim().toLocaleLowerCase('uk');
  const direction = $('#statementDirection').value;
  const fromDate = $('#statementFromDate').value;
  const toDate = $('#statementToDate').value;
  return statementTransactions().filter((entry) => {
    const dateKey = statementDateKey(entry.date);
    if (direction !== 'all' && entry.direction !== direction) return false;
    if (fromDate && dateKey < fromDate) return false;
    if (toDate && dateKey > toDate) return false;
    if (!query) return true;
    const products = (entry.productGuess?.candidates || []).flat().map((item) => item.name).join(' ');
    const text = [entry.id, entry.date, entry.time, entry.direction, entry.details, entry.counterpartyName,
      entry.counterpartyIban, entry.counterpartyTaxId, entry.operationAmount, entry.accountAmount,
      entry.currency, entry.exchangeRate, entry.commission, entry.balanceAfter, entry.maskedCard, products,
      Number(entry.operationAmount).toFixed(2), Number(entry.accountAmount).toFixed(2), Number(entry.balanceAfter).toFixed(2)]
      .join(' ').toLocaleLowerCase('uk');
    return text.includes(query);
  });
}

function updateStats() {
  const waiting = state.orders.filter((order) => order.status === 'awaiting_payment').length;
  const paidOrders = state.orders.filter((order) => ['paid', 'processing', 'shipped'].includes(order.status));
  const processing = state.orders.filter((order) => order.status === 'processing').length;
  const paidAmount = paidOrders.reduce((total, order) => total + order.amount, 0);
  $('#statTotal').textContent = state.orders.length;
  $('#statWaiting').textContent = waiting;
  $('#statPaid').textContent = paidOrders.length;
  $('#statPaidAmount').textContent = `${formatMoney(paidAmount)} підтверджено`;
  $('#statProcessing').textContent = processing;
  $('#siteOrdersTabCount').textContent = state.orders.length;
}

function orderRow(order) {
  const items = order.items.map((item) => `<li>${escapeHTML(item.name)} · ${item.quantity} шт.</li>`).join('');
  const statusOptions = Object.entries(statusLabels).map(([value, label]) =>
    `<option value="${value}" ${order.status === value ? 'selected' : ''}>${label}</option>`
  ).join('');
  return `<tr>
    <td><span class="order-reference">${escapeHTML(order.reference)}</span><span class="order-date">${escapeHTML(formatDate(order.createdAt))} · ${escapeHTML(formatTime(order.createdAt))}</span></td>
    <td><span class="buyer-name">${escapeHTML(order.name)}</span><a class="buyer-phone" href="tel:${escapeHTML(order.phone)}">${escapeHTML(order.phone)}</a></td>
    <td><ul class="order-items">${items}</ul></td>
    <td><strong class="order-amount">${escapeHTML(formatMoney(order.amount))}</strong></td>
    <td class="order-delivery">${escapeHTML(order.delivery)}</td>
    <td><select class="status-select" data-order-status="${escapeHTML(order.reference)}" data-status="${escapeHTML(order.status)}" aria-label="Статус замовлення ${escapeHTML(order.reference)}">${statusOptions}</select></td>
  </tr>`;
}

function productCandidateText(candidate) {
  return candidate.map((item) => `${item.name} × ${item.quantity} · ${formatMoney(item.unitPrice)}${item.priceFrom !== item.priceTo ? ` (${formatMoney(item.priceFrom)}–${formatMoney(item.priceTo)})` : ''}`).join(' + ');
}

function productMatch(entry) {
  if (entry.direction !== 'credit') return '<span class="product-kind product-kind-muted">Списання, не заявка</span>';
  const guess = entry.productGuess || {};
  const candidates = guess.candidates || [];
  if (!candidates.length) return '<span class="product-kind product-kind-muted">Збігу за сумою немає</span>';
  const label = guess.kind === 'exact_single' ? 'Точний збіг за сумою'
    : guess.kind === 'within_range' ? 'У межах цінового діапазону'
      : guess.kind === 'nearest' ? 'Найближчі варіанти'
        : `${candidates.length} можливі варіанти`;
  const first = productCandidateText(candidates[0]);
  const more = candidates.length > 1
    ? `<details class="product-alternatives"><summary>Показати варіанти</summary><ol>${candidates.map((candidate) => `<li>${escapeHTML(productCandidateText(candidate))}</li>`).join('')}</ol></details>`
    : '';
  return `<span class="product-kind">${escapeHTML(label)}</span><span class="product-primary">${escapeHTML(first)}</span>${more}`;
}

function field(label, value) {
  return `<div class="transaction-field"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value == null || value === '' ? '—' : value)}</strong></div>`;
}

function statementRow(entry) {
  const isCredit = entry.direction === 'credit';
  const transactionDetails = String(entry.details || '').split('\n').map(escapeHTML).join('<br>');
  const details = `<div class="transaction-fields">
      ${field('Повні деталі з виписки', entry.details)}
      ${field('Контрагент', entry.counterpartyName)}
      ${field('IBAN контрагента', entry.counterpartyIban)}
      ${field('Податковий номер', entry.counterpartyTaxId)}
      ${field('Сума операції', `${Number(entry.operationAmount).toFixed(2)} ${entry.currency || ''}`)}
      ${field('Валюта операції', entry.currency)}
      ${field('Сума у валюті рахунку', `${Number(entry.accountAmount).toFixed(2)} UAH`)}
      ${field('Курс', entry.exchangeRate)}
      ${field('Комісія', entry.commission)}
      ${field('Залишок після операції', `${Number(entry.balanceAfter).toFixed(2)} UAH`)}
      ${field('Картка', entry.maskedCard)}
      ${field('Сторінка / рядок PDF', `${entry.sourcePage} / ${entry.sourceRow}`)}
      ${field('ID імпорту', entry.id)}
    </div>`;
  return `<tr>
    <td><span class="statement-date">${escapeHTML(entry.date)}</span><strong class="statement-time">${escapeHTML(entry.time)}</strong></td>
    <td><span class="direction-pill ${isCredit ? 'is-credit' : 'is-debit'}">${isCredit ? 'Надходження' : 'Списання'}</span></td>
    <td class="statement-counterparty"><strong>${escapeHTML(entry.counterpartyName || '—')}</strong><span>${transactionDetails || '—'}</span><details class="transaction-more"><summary>Усі поля · PDF ${escapeHTML(entry.sourcePage)}:${escapeHTML(entry.sourceRow)}</summary>${details}</details></td>
    <td><strong class="statement-amount ${isCredit ? 'is-positive' : 'is-negative'}">${escapeHTML(formatMoney(entry.operationAmount, 2))}</strong></td>
    <td><strong class="statement-balance">${escapeHTML(formatMoney(entry.balanceAfter, 2))}</strong></td>
    <td class="statement-product">${productMatch(entry)}</td>
  </tr>`;
}

function updateStatementStats() {
  const summary = state.statement?.summary;
  const transactions = statementTransactions();
  if (!summary) return;
  const credits = transactions.filter((entry) => entry.direction === 'credit');
  const debits = transactions.filter((entry) => entry.direction === 'debit');
  const creditTotal = credits.reduce((total, entry) => total + Number(entry.accountAmount), 0);
  const debitTotal = debits.reduce((total, entry) => total + Math.abs(Number(entry.accountAmount)), 0);
  $('#statementTitle').textContent = summary.statementTitle;
  const accountDetails = [summary.bank, summary.accountHolder, summary.accountIban ? `IBAN ${summary.accountIban}` : ''].filter(Boolean);
  $('#statementAccount').textContent = accountDetails.join(' · ');
  $('#statementStatTotal').textContent = transactions.length;
  $('#statementStatCredits').textContent = credits.length;
  $('#statementStatDebits').textContent = debits.length;
  $('#statementCreditAmount').textContent = formatMoney(creditTotal, 2);
  $('#statementDebitAmount').textContent = formatMoney(debitTotal, 2);
  $('#statementClosingBalance').textContent = formatMoney(summary.closingBalance, 2);
  $('#statementOpeningBalance').textContent = `Початковий залишок: ${formatMoney(summary.openingBalance, 2)}`;
  $('#statementPeriod').textContent = summary.periodStart && summary.periodEnd
    ? `Період ${summary.periodStart} — ${summary.periodEnd}`
    : 'Дані виписки не імпортовані';
  $('#statementTabCount').textContent = transactions.length;
  const sourceAvailable = Boolean(state.statement?.sourceFileName);
  $('#statementPdfLink').hidden = !sourceAvailable;
  $('.statement-source').hidden = !sourceAvailable;
}

function render() {
  updateStats();
  const orders = filteredOrders();
  $('#visibleCount').textContent = `(${orders.length})`;
  $('#ordersTableBody').innerHTML = orders.map(orderRow).join('');
  $('#emptyOrders').hidden = state.orders.length !== 0;
  $('#noMatches').hidden = state.orders.length === 0 || orders.length !== 0;
  $('#ordersTableBody').querySelectorAll('[data-order-status]').forEach((select) => {
    select.addEventListener('change', () => updateOrderStatus(select));
  });

  updateStatementStats();
  const entries = filteredStatement();
  $('#statementVisibleCount').textContent = `(${entries.length} з ${statementTransactions().length})`;
  $('#statementTableBody').innerHTML = entries.map(statementRow).join('');
  $('#emptyStatement').hidden = statementTransactions().length !== 0;
  $('#noStatementMatches').hidden = statementTransactions().length === 0 || entries.length !== 0;
}

async function loadOrders() {
  if (state.loading) return;
  state.loading = true;
  $('#refreshButton').disabled = true;
  $('#statementRefreshButton').disabled = true;
  try {
    const data = await request('/api/admin/orders');
    state.orders = data.orders || [];
    state.statement = data.statement || null;
    render();
    $('#loginPanel').hidden = true;
    $('#adminDashboard').hidden = false;
    $('#logoutButton').hidden = false;
  } catch (error) {
    if (error.status === 401) {
      $('#adminDashboard').hidden = true;
      $('#loginPanel').hidden = false;
      $('#logoutButton').hidden = true;
    }
    showLoginError(error.message);
  } finally {
    state.loading = false;
    $('#refreshButton').disabled = false;
    $('#statementRefreshButton').disabled = false;
  }
}

function showLoginError(message) {
  const error = $('#loginError');
  error.textContent = message;
  error.hidden = false;
}

async function updateOrderStatus(select) {
  const reference = select.dataset.orderStatus;
  const previousStatus = select.dataset.status;
  select.disabled = true;
  try {
    await request(`/api/admin/orders/${encodeURIComponent(reference)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: select.value })
    });
    const order = state.orders.find((entry) => entry.reference === reference);
    if (order) order.status = select.value;
    select.dataset.status = select.value;
    showNotice(`Статус ${reference} оновлено: ${statusLabels[select.value]}.`);
    render();
  } catch (error) {
    select.value = previousStatus;
    if (error.status === 401) {
      $('#adminDashboard').hidden = true;
      $('#loginPanel').hidden = false;
      $('#logoutButton').hidden = true;
    }
    showNotice(error.message, true);
  } finally {
    select.disabled = false;
  }
}

function csvCell(value) {
  if (typeof value === 'string' && /^[=+@\-\t\r]/.test(value)) value = `'${value}`;
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function downloadCsv(rows, filename) {
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(';')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportCsv() {
  const orders = filteredOrders();
  downloadCsv([
    ['Замовлення', 'Дата', 'Покупець', 'Телефон', 'Товари', 'Сума, UAH', 'Доставка', 'Статус'],
    ...orders.map((order) => [
      order.reference,
      `${formatDate(order.createdAt)} ${formatTime(order.createdAt)}`,
      order.name,
      order.phone,
      order.items.map((item) => `${item.name} × ${item.quantity}`).join('; '),
      order.amount,
      order.delivery,
      statusLabels[order.status] || order.status
    ])
  ], `autora-orders-${new Date().toISOString().slice(0, 10)}.csv`);
}

function exportStatementCsv() {
  downloadCsv([
    ['ID', 'Сторінка PDF', 'Рядок PDF', 'Дата', 'Час', 'Тип', 'Деталі', 'Контрагент', 'IBAN', 'Податковий номер', 'Сума операції', 'Валюта', 'Сума у валюті рахунку', 'Курс', 'Комісія', 'Баланс після операції', 'Картка', 'Орієнтовні товари за сумою'],
    ...filteredStatement().map((entry) => {
      const candidates = (entry.productGuess?.candidates || []).map(productCandidateText).join(' | ');
      return [entry.id, entry.sourcePage, entry.sourceRow, entry.date, entry.time, entry.direction, entry.details,
        entry.counterpartyName, entry.counterpartyIban, entry.counterpartyTaxId, entry.operationAmount, entry.currency,
        entry.accountAmount, entry.exchangeRate, entry.commission, entry.balanceAfter, entry.maskedCard, candidates];
    })
  ], `statement-orders-${new Date().toISOString().slice(0, 10)}.csv`);
}

function setActiveTab(name) {
  const statementActive = name === 'statement';
  $('#statementPanel').hidden = !statementActive;
  $('#siteOrdersPanel').hidden = statementActive;
  $('#statementTab').classList.toggle('is-active', statementActive);
  $('#siteOrdersTab').classList.toggle('is-active', !statementActive);
  $('#statementTab').setAttribute('aria-selected', String(statementActive));
  $('#siteOrdersTab').setAttribute('aria-selected', String(!statementActive));
}

async function initialize() {
  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#loginForm button');
    const error = $('#loginError');
    error.hidden = true;
    button.disabled = true;
    try {
      await request('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('#adminPassword').value })
      });
      $('#adminPassword').value = '';
      await loadOrders();
    } catch (loginError) {
      showLoginError(loginError.message);
    } finally {
      button.disabled = false;
    }
  });

  $('#logoutButton').addEventListener('click', async () => {
    try { await request('/api/admin/logout', { method: 'POST' }); } catch { /* The browser will still return to the login panel. */ }
    state.orders = [];
    state.statement = null;
    $('#adminDashboard').hidden = true;
    $('#loginPanel').hidden = false;
    $('#logoutButton').hidden = true;
  });

  $('#refreshButton').addEventListener('click', loadOrders);
  $('#statementRefreshButton').addEventListener('click', loadOrders);
  $('#exportButton').addEventListener('click', exportCsv);
  $('#statementExportButton').addEventListener('click', exportStatementCsv);
  $('#searchInput').addEventListener('input', render);
  $('#statusFilter').addEventListener('change', render);
  $('#fromDate').addEventListener('change', render);
  $('#toDate').addEventListener('change', render);
  $('#clearFilters').addEventListener('click', () => {
    $('#searchInput').value = '';
    $('#statusFilter').value = 'all';
    $('#fromDate').value = '';
    $('#toDate').value = '';
    render();
  });
  $('#statementSearch').addEventListener('input', render);
  $('#statementDirection').addEventListener('change', render);
  $('#statementFromDate').addEventListener('change', render);
  $('#statementToDate').addEventListener('change', render);
  $('#statementClearFilters').addEventListener('click', () => {
    $('#statementSearch').value = '';
    $('#statementDirection').value = 'all';
    $('#statementFromDate').value = '';
    $('#statementToDate').value = '';
    render();
  });
  document.querySelectorAll('[data-admin-tab]').forEach((button) => {
    button.addEventListener('click', () => setActiveTab(button.dataset.adminTab));
  });

  try {
    const session = await request('/api/admin/session');
    $('#loginPanel').hidden = session.authenticated;
    if (session.authenticated) await loadOrders();
  } catch (error) {
    $('#loginPanel').hidden = false;
    showLoginError(error.message);
  }
}

initialize();
