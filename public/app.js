const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const CART_KEY = 'autora-cart-v1';
const FAVORITES_KEY = 'autora-favorites-v1';
const ADMIN_TRIGGER_PRODUCT_ID = 11;
const PAGE_SIZE = 12;

const state = {
  products: [],
  shown: PAGE_SIZE,
  category: 'Усі товари',
  price: 'all',
  search: '',
  sort: 'featured',
  cart: readStore(CART_KEY, {}),
  favorites: readStore(FAVORITES_KEY, []),
  toastTimer: null
};

const categoryColors = {};

function readStore(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function saveStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Browsing still works if storage is disabled. */ }
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function transliterate(value) {
  const table = {
    а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ye', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'yi', й: 'i',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch',
    ш: 'sh', щ: 'shch', ю: 'yu', я: 'ya', ь: '', 'ъ': '', 'ы': 'y', 'э': 'e', 'ё': 'yo', '’': '', "'": '', '`': ''
  };
  return [...String(value).toLowerCase()].map((char) => table[char] ?? char).join('');
}

function normalizeSearch(value) {
  return transliterate(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ye/g, 'ie').replace(/yi/g, 'i').replace(/[^a-z0-9]+/g, ' ').trim();
}

function slugify(value, id) {
  return `${transliterate(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').replace(/-{2,}/g, '-')}-${id}`;
}

function categoryFor(name) {
  const lower = name.toLowerCase();
  if (/реєстратор|камер|огляд|360|паркуван|паркувальн|радар|tpms|тиску шин|тиску в шинах|сканер/.test(lower)) return 'Камери та безпека';
  if (/магнітол|мультимед|carplay|трансмітер/.test(lower)) return 'Мультимедіа';
  if (/компресор/.test(lower) && !/холодиль/.test(lower) || /пусков|jump|інвертор|пускові дроти|запобіж|ремонту.*шин/.test(lower)) return 'Живлення та інструмент';
  if (/холодиль|подорож/.test(lower)) return 'Для подорожей';
  if (/пилосос|поліру|детейл|хім|щітк|мікроф|мийк|парооч|екстракт|скребок|губк|догляд|очищення/.test(lower)) return 'Догляд за авто';
  return 'Комфорт у салоні';
}

function money(value) {
  return new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 }).format(value);
}

function unitPrice(product) {
  return Math.round((product.price_from + product.price_to) / 2);
}

function productById(id) {
  return state.products.find((product) => product.id === Number(id));
}

function cartEntries() {
  return Object.entries(state.cart).map(([id, quantity]) => ({ product: productById(id), quantity: Number(quantity) })).filter((entry) => entry.product && entry.quantity > 0);
}

function cartCount() {
  return cartEntries().reduce((total, entry) => total + entry.quantity, 0);
}

function productPhoto(product, className = 'product-photo') {
  return `<img class="${className}" src="${escapeHTML(product.image_url || '')}" alt="${escapeHTML(product.name)}" loading="lazy" decoding="async" />`;
}

function bindPhotoFallbacks(root = document) {
  $$('.product-photo, .detail-photo, .cart-photo, .hero-product-photo', root).forEach((photo) => {
    const markBroken = () => {
      photo.classList.add('is-broken');
      photo.closest('.product-art, .product-detail-art, .cart-item-art, .hero-product-tile')?.classList.add('photo-unavailable');
    };
    photo.addEventListener('error', markBroken, { once: true });
    if (photo.complete && photo.naturalWidth === 0) markBroken();
  });
}

function renderHeroPhotoShowcase() {
  const showcase = $('#heroPhotoShowcase');
  const preferred = [43, 73, 41].map(productById).filter(Boolean);
  const spotlight = [...preferred, ...state.products.filter((product) => !preferred.includes(product))].slice(0, 3);
  showcase.innerHTML = spotlight.map((product, index) => `<a class="hero-product-tile hero-tile-${index + 1}" href="/tovar/${product.slug}" data-product-link="${product.id}" aria-label="Переглянути ${escapeHTML(product.name)}">${productPhoto(product, 'hero-product-photo')}<span>${escapeHTML(product.name)}</span></a>`).join('');
  bindPhotoFallbacks(showcase);
}

function cartTotal() {
  return cartEntries().reduce((total, entry) => total + unitPrice(entry.product) * entry.quantity, 0);
}

function inPriceBand(product) {
  const price = unitPrice(product);
  switch (state.price) {
    case 'under-1000': return price < 1000;
    case '1000-5000': return price >= 1000 && price < 5000;
    case '5000-12000': return price >= 5000 && price < 12000;
    case 'over-12000': return price >= 12000;
    default: return true;
  }
}

function filteredProducts() {
  let result = state.products.filter((product) => {
    const matchesCategory = state.category === 'Усі товари' || (state.category === 'Обране' ? state.favorites.includes(product.id) : categoryFor(product.name) === state.category);
    const normalizedQuery = normalizeSearch(state.search);
    const searchHaystack = normalizeSearch(`${product.name} ${product.slug} ${product.id}`);
    const matchesSearch = !normalizedQuery || searchHaystack.includes(normalizedQuery);
    return matchesCategory && matchesSearch && inPriceBand(product);
  });

  if (state.sort === 'price-asc') result = [...result].sort((a, b) => unitPrice(a) - unitPrice(b));
  if (state.sort === 'price-desc') result = [...result].sort((a, b) => unitPrice(b) - unitPrice(a));
  if (state.sort === 'name') result = [...result].sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  if (state.sort === 'featured') {
    const featured = [43, 23, 41, 73, 27, 40, 62, 77, 102, 17, 106, 48];
    const position = id => featured.includes(id) ? featured.indexOf(id) : featured.length + id;
    result = [...result].sort((a, b) => position(a.id) - position(b.id));
  }
  return result;
}

function cardMarkup(product, position) {
  const category = categoryFor(product.name);
  const color = categoryColors[category] || 'sage';
  const selected = state.favorites.includes(product.id);
  const start = product.price_from;
  const end = product.price_to;
  return `<article class="product-card reveal" style="--card-delay:${Math.min(position % 12, 8) * 55}ms">
    <div class="product-art art-${color}">
      <span class="art-index">№ ${String(product.id).padStart(3, '0')}</span>
      ${productPhoto(product)}

      <span class="art-caption">${escapeHTML(category)}</span>
      <button class="favorite-button ${selected ? 'is-favorite' : ''}" type="button" data-favorite="${product.id}" aria-label="${selected ? 'Прибрати з обраного' : 'Додати в обране'}">${selected ? '♥' : '♡'}</button>
      <a class="art-hit" href="/tovar/${product.slug}" data-product-link="${product.id}" aria-label="Переглянути ${escapeHTML(product.name)}"></a>
    </div>
    <div class="product-card-copy">
      <div class="product-category-line"><span>${escapeHTML(category)}</span><span class="product-dot"></span><span>${start}–${end} ₴</span></div>
      <a class="product-title" href="/tovar/${product.slug}" data-product-link="${product.id}">${escapeHTML(product.name)}</a>
      <div class="product-card-bottom"><div><strong>${money(unitPrice(product))} ₴</strong><small>орієнтовно</small></div><button class="add-button" data-add="${product.id}" type="button" aria-label="Додати до кошика: ${escapeHTML(product.name)}"><span>+</span></button></div>
    </div>
  </article>`;
}

function renderCategories() {
  const categories = ['Усі товари', 'Комфорт у салоні', 'Камери та безпека', 'Мультимедіа', 'Живлення та інструмент', 'Догляд за авто', 'Для подорожей', 'Обране'];
  $('#categoryFilters').innerHTML = categories.map(category => {
    const count = category === 'Усі товари' ? state.products.length : category === 'Обране' ? state.favorites.length : state.products.filter(p => categoryFor(p.name) === category).length;
    return `<button class="category-chip ${state.category === category ? 'is-active' : ''}" type="button" data-category="${category}" aria-pressed="${state.category === category}">${category}<span class="category-chip-count">${count}</span></button>`;
  }).join('');
  $('#favoritesCount').textContent = state.favorites.length;
}

function renderCatalog() {
  const products = filteredProducts();
  const shown = products.slice(0, state.shown);
  $('#productGrid').innerHTML = shown.map(cardMarkup).join('');
  bindPhotoFallbacks($('#productGrid'));
  $('#resultsCount').innerHTML = `<strong>${products.length}</strong> ${products.length === 1 ? 'товар' : products.length > 1 && products.length < 5 ? 'товари' : 'товарів'} знайдено`;
  $('#shownCount').textContent = products.length ? `${shown.length} з ${products.length}` : '';
  $('#loadMore').hidden = products.length <= state.shown;
  $('#emptyState').hidden = products.length !== 0;
  $('#clearFilters').hidden = !(state.search || state.category !== 'Усі товари' || state.price !== 'all');
  observeReveals();
}

function renderCart() {
  const entries = cartEntries();
  const count = cartCount();
  $('#cartCount').textContent = count;
  $('#drawerCartCount').textContent = `(${count})`;
  $('#cartItems').innerHTML = entries.map(({ product, quantity }) => `<article class="cart-item">
    <div class="cart-item-art art-${categoryColors[categoryFor(product.name)] || 'sage'}">${productPhoto(product, 'cart-photo')}</div>
    <div class="cart-item-info"><a href="/tovar/${product.slug}" data-product-link="${product.id}">${escapeHTML(product.name)}</a><small>${money(unitPrice(product))} ₴ · орієнтовно</small><div class="quantity-control"><button type="button" data-quantity="${product.id}" data-delta="-1" aria-label="Зменшити кількість">−</button><span>${quantity}</span><button type="button" data-quantity="${product.id}" data-delta="1" aria-label="Збільшити кількість">+</button></div></div>
    <b class="cart-item-total">${money(unitPrice(product) * quantity)} ₴</b>
    <button class="remove-item" type="button" data-remove="${product.id}" aria-label="Прибрати ${escapeHTML(product.name)} з кошика">×</button>
  </article>`).join('');
  $('#emptyCart').hidden = entries.length > 0;
  $('#cartFooter').hidden = entries.length === 0;
  $('#cartTotal').textContent = `${money(cartTotal())} ₴`;
  $('#checkoutTotal').textContent = `${money(cartTotal())} ₴`;
  bindPhotoFallbacks($('#cartItems'));
}

function addToCart(id) {
  if (!productById(id)) return;
  if ((state.cart[id] || 0) >= 50) return showToast('Не більше 50 одиниць одного товару.');
  if (!state.cart[id] && cartEntries().length >= 25) return showToast('До 25 різних товарів в одному замовленні.');
  state.cart[id] = (state.cart[id] || 0) + 1;
  saveStore(CART_KEY, state.cart);
  renderCart();
  showToast('Товар у кошику');
}

function changeQuantity(id, delta) {
  const next = (state.cart[id] || 0) + delta;
  if (next > 50) return showToast('Не більше 50 одиниць одного товару.');
  if (next <= 0) delete state.cart[id]; else state.cart[id] = next;
  saveStore(CART_KEY, state.cart);
  renderCart();
}

function toggleFavorite(id) {
  const itemId = Number(id);
  if (state.favorites.includes(itemId)) state.favorites = state.favorites.filter((favorite) => favorite !== itemId);
  else state.favorites = [...state.favorites, itemId];
  saveStore(FAVORITES_KEY, state.favorites);
  renderCategories();
  renderCatalog();
  showToast(state.favorites.includes(itemId) ? 'Зберегли в обраному ♡' : 'Прибрали з обраного');
}

async function openAdminPortal(button) {
  if (button) button.disabled = true;
  try {
    const response = await fetch('/api/admin/entry', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Не вдалося відкрити панель адміністратора.');
    window.location.assign('/staff-console');
  } catch (error) {
    showToast(error.message || 'Не вдалося відкрити панель адміністратора.');
  } finally {
    if (button) button.disabled = false;
  }
}

function openCart() {
  state.cartFocus = document.activeElement;
  $('#cartDrawer').inert = false;
  $('#scrim').hidden = false;
  requestAnimationFrame(() => {
    $('#scrim').classList.add('is-visible');
    $('#cartDrawer').classList.add('is-open');
  });
  $('#cartDrawer').setAttribute('aria-hidden', 'false');
  document.body.classList.add('no-scroll');
  window.setTimeout(() => $('#closeCart').focus(), 80);
}

function closeCart() {
  $('#cartDrawer').classList.remove('is-open');
  $('#scrim').classList.remove('is-visible');
  $('#cartDrawer').setAttribute('aria-hidden', 'true');
  $('#cartDrawer').inert = true;
  document.body.classList.remove('no-scroll');
  state.cartFocus?.focus();
  window.setTimeout(() => { $('#scrim').hidden = true; }, 280);
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2500);
}

function setProductMeta(product) {
  document.title = `${product.name} — AUTORA`;
  $('meta[name="description"]').content = `${product.name}. ${money(unitPrice(product))} грн. Автоаксесуари AUTORA.`;
}

function showStorePage() {
  const productPage = $('#productPage');
  if (productPage) productPage.hidden = true;
  $$('.hero, .benefits, .catalog-section, .about-section, .faq-section, .newsletter-card').forEach((section) => { section.hidden = false; });
  document.body.classList.remove('product-page-open');
  document.title = 'AUTORA — аксесуари для твого авто';
  $('meta[name="description"]').content = 'AUTORA — 235 аксесуарів для автомобіля. Електроніка, комфорт у салоні, догляд та обладнання для подорожей.';
}

function productPageMarkup(product) {
  const category = categoryFor(product.name);
  const color = categoryColors[category] || 'sage';
  const related = state.products.filter((item) => item.id !== product.id && categoryFor(item.name) === category).slice(0, 4);
  return `<div class="product-breadcrumb"><a href="/#catalog" data-back-to-catalog>Каталог</a><span>／</span><span>${escapeHTML(category)}</span><span>／</span><span>${escapeHTML(product.name)}</span></div>
    <div class="product-detail-layout">
      <div class="product-detail-media"><div class="product-detail-art art-${color}">${productPhoto(product, 'detail-photo')}<span class="detail-art-label">№ ${String(product.id).padStart(3, '0')}</span><button class="photo-zoom-button" type="button" data-photo-zoom aria-label="Розглянути ілюстрацію товару"> Розглянути ілюстрацію</button></div><p class="photo-source">Ілюстрація AUTORA. Зовнішній вигляд конкретної моделі може відрізнятися.</p></div>
      <div class="product-detail-copy"><span class="eyebrow">ДЕТАЛЬ ДЛЯ ТВОГО МАРШРУТУ</span><h1>${escapeHTML(product.name)}</h1><div class="detail-price"><strong>${money(unitPrice(product))} ₴</strong><span>орієнтовно · діапазон ${product.price_from}–${product.price_to} ₴</span></div><p class="detail-description">Аксесуар із каталогу AUTORA. Ціна замовлення — середина зазначеного діапазону. Перед оплатою перевір сумісність із моделлю свого авто. Доставка оплачується окремо.</p><div class="detail-facts"><div><span class="fact-check">✓</span><span>Номер у списку</span><b>${String(product.id).padStart(3, '0')}</b></div><div><span class="fact-check">✓</span><span>Категорія</span><b>${escapeHTML(category)}</b></div><div><span class="fact-check">✓</span><span>Оплата переказом</span><b>після оформлення</b></div></div><button class="button button-dark detail-add" type="button" data-add="${product.id}">Додати до кошика <span>+</span></button><button class="detail-favorite ${state.favorites.includes(product.id) ? 'is-favorite' : ''}" type="button" data-favorite="${product.id}">${state.favorites.includes(product.id) ? '♥' : '♡'} <span>${state.favorites.includes(product.id) ? 'В обраному' : 'Додати в обране'}</span></button><p class="detail-note">Реквізити та точну суму для переказу покажемо після оформлення кошика.</p></div>
    </div><section class="related-products"><div class="related-heading"><div><span class="eyebrow">ЩЕ З ЦІЄЇ КАТЕГОРІЇ</span><h2>Вам може <em>сподобатись</em></h2></div><a href="/#catalog" data-back-to-catalog>Увесь каталог</a></div><div class="related-grid">${related.map((item, index) => cardMarkup(item, index)).join('')}</div></section><a class="more-products-link" href="/#catalog" data-back-to-catalog>Повернутися до каталогу</a>`;
}

function route() {
  const match = location.pathname.match(/^\/tovar\/([^/]+)\/?$/);
  if (!match) {
    showStorePage();
    return;
  }
  const product = state.products.find((item) => item.slug === match[1]);
  if (!product) {
    showStorePage();
    showToast('Не знайшли такий товар у каталозі');
    return;
  }
  let productPage = $('#productPage');
  if (!productPage) {
    productPage = document.createElement('section');
    productPage.id = 'productPage';
    productPage.className = 'product-page';
    $('#main').prepend(productPage);
  }
  productPage.hidden = false;
  productPage.innerHTML = productPageMarkup(product);
  bindPhotoFallbacks(productPage);
  $$('.hero, .benefits, .catalog-section, .about-section, .faq-section, .newsletter-card').forEach((section) => { section.hidden = true; });
  document.body.classList.add('product-page-open');
  setProductMeta(product);
  observeReveals();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function navigateToProduct(id) {
  const product = productById(id);
  if (!product) return;
  history.pushState({ productId: product.id }, '', `/tovar/${product.slug}`);
  route();
}

function clearFilters() {
  state.category = 'Усі товари';
  state.price = 'all';
  state.search = '';
  state.shown = PAGE_SIZE;
  $('#searchInput').value = '';
  $$('.price-chip').forEach((button) => button.classList.toggle('is-active', button.dataset.price === 'all'));
  renderCategories();
  renderCatalog();
}

function observeReveals() {
  const elements = $$('.reveal:not(.revealed)');
  if (!('IntersectionObserver' in window)) {
    elements.forEach((element) => element.classList.add('revealed'));
    return;
  }
  const observer = new IntersectionObserver((entries, currentObserver) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        currentObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -24px 0px' });
  elements.forEach((element) => observer.observe(element));
}

function setupEvents() {
  $('#categoryFilters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-category]');
    if (!button) return;
    state.category = button.dataset.category;
    state.shown = PAGE_SIZE;
    renderCategories();
    renderCatalog();
  });

  $('#searchInput').addEventListener('input', (event) => {
    state.search = event.target.value;
    state.shown = PAGE_SIZE;
    renderCatalog();
  });

  $('#sortSelect').addEventListener('change', (event) => {
    state.sort = event.target.value;
    renderCatalog();
  });

  $$('.price-chip').forEach((button) => button.addEventListener('click', () => {
    state.price = button.dataset.price;
    state.shown = PAGE_SIZE;
    $$('.price-chip').forEach((chip) => chip.classList.toggle('is-active', chip === button));
    renderCatalog();
  }));

  $('#productGrid').addEventListener('click', (event) => {
    const add = event.target.closest('[data-add]');
    const favorite = event.target.closest('[data-favorite]');
    const productLink = event.target.closest('[data-product-link]');
    if (add) { event.preventDefault(); event.stopPropagation(); addToCart(add.dataset.add); }
    else if (favorite) { event.preventDefault(); event.stopPropagation(); toggleFavorite(favorite.dataset.favorite); }
    else if (productLink) { event.preventDefault(); navigateToProduct(productLink.dataset.productLink); }
  });

  $('#cartItems').addEventListener('click', (event) => {
    const quantity = event.target.closest('[data-quantity]');
    const remove = event.target.closest('[data-remove]');
    const productLink = event.target.closest('[data-product-link]');
    if (quantity) changeQuantity(quantity.dataset.quantity, Number(quantity.dataset.delta));
    else if (remove) changeQuantity(remove.dataset.remove, -Number(state.cart[remove.dataset.remove] || 0));
    else if (productLink) { event.preventDefault(); closeCart(); navigateToProduct(productLink.dataset.productLink); }
  });

  $('#openCart').addEventListener('click', openCart);
  $('#closeCart').addEventListener('click', closeCart);
  $('#scrim').addEventListener('click', closeCart);
  $('#continueShopping').addEventListener('click', closeCart);
  $('#loadMore').addEventListener('click', () => { state.shown += PAGE_SIZE; renderCatalog(); });
  $('#clearFilters').addEventListener('click', clearFilters);
  $('#resetSearch').addEventListener('click', clearFilters);
  $('#focusSearch').addEventListener('click', () => { if (location.pathname !== '/') { history.pushState({}, '', '/#catalog'); route(); } $('#searchInput').focus(); $('#catalog').scrollIntoView({ behavior: 'smooth' }); });
  $('#focusSearch').addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#searchInput').focus(); } });

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (location.pathname !== '/') { history.pushState({}, '', '/#catalog'); route(); }
      $('#searchInput').focus();
      $('#catalog').scrollIntoView({ behavior: 'smooth' });
    }
    if (event.key === 'Escape' && $('#cartDrawer').classList.contains('is-open')) closeCart();
    if (event.key === 'Tab' && $('#cartDrawer').classList.contains('is-open')) {
      const focusable = $$('button:not([disabled]), a[href], input', $('#cartDrawer')).filter(el => el.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });

  document.addEventListener('click', (event) => {
    const backLink = event.target.closest('[data-back-to-catalog]');
    const detailAdd = event.target.closest('#productPage [data-add]');
    const detailFavorite = event.target.closest('#productPage [data-favorite]');
    const photoZoom = event.target.closest('#productPage [data-photo-zoom]');
    const relatedLink = event.target.closest('#productPage [data-product-link]');
    const heroProductLink = event.target.closest('.hero-photo-showcase [data-product-link]');
    if (backLink) {
      event.preventDefault();
      history.pushState({}, '', '/#catalog');
      route();
      $('#catalog').scrollIntoView({ behavior: 'smooth' });
    }
    if (detailAdd) { addToCart(detailAdd.dataset.add); }
    if (detailFavorite) {
      if (Number(detailFavorite.dataset.favorite) === ADMIN_TRIGGER_PRODUCT_ID) {
        event.preventDefault();
        event.stopPropagation();
        openAdminPortal(detailFavorite);
      } else {
        toggleFavorite(detailFavorite.dataset.favorite);
        route();
      }
    }
    if (photoZoom) {
      const product = state.products.find((item) => item.id === Number($('#productPage .detail-add')?.dataset.add));
      if (product) {
        $('#photoZoomImage').src = product.image_url;
        $('#photoZoomImage').alt = product.name;
        $('#photoZoomCaption').textContent = product.name;
        if (typeof $('#photoZoomDialog').showModal === 'function') $('#photoZoomDialog').showModal();
      }
    }
    if (relatedLink) { event.preventDefault(); navigateToProduct(relatedLink.dataset.productLink); }
    if (heroProductLink) { event.preventDefault(); navigateToProduct(heroProductLink.dataset.productLink); }
  });

  $('#menuToggle').addEventListener('click', () => {
    const isOpen = $('#menuToggle').getAttribute('aria-expanded') === 'true';
    $('#menuToggle').setAttribute('aria-expanded', String(!isOpen));
    $('.main-nav').classList.toggle('is-open', !isOpen);
  });
  $('#openFavorites').addEventListener('click', () => {
    history.pushState({}, '', '/#catalog');
    route();
    clearFilters();
    state.category = 'Обране';
    renderCategories();
    renderCatalog();
    $('#catalog').scrollIntoView({ behavior: 'smooth' });
  });
  $$('.main-nav a').forEach((link) => link.addEventListener('click', () => {
    $('.main-nav').classList.remove('is-open');
    $('#menuToggle').setAttribute('aria-expanded', 'false');
  }));

  $('#checkoutButton').addEventListener('click', () => {
    closeCart();
    renderCart();
    $('#checkoutError').hidden = true;
    if (typeof $('#checkoutDialog').showModal === 'function') $('#checkoutDialog').showModal();
    else $('#checkoutDialog').setAttribute('open', '');
  });
  $('#closeCheckout').addEventListener('click', () => $('#checkoutDialog').close());
  $('#checkoutDialog').addEventListener('click', (event) => { if (event.target === $('#checkoutDialog')) $('#checkoutDialog').close(); });
  $('#checkoutForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!$('#checkoutForm').reportValidity()) return;
    const submitButton = $('.checkout-submit');
    const errorMessage = $('#checkoutError');
    errorMessage.hidden = true;
    submitButton.disabled = true;
    submitButton.textContent = 'Зберігаємо замовлення…';
    try {
      const form = new FormData($('#checkoutForm'));
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          name: form.get('name'),
          phone: form.get('phone'),
          delivery: form.get('delivery'),
          items: cartEntries().map(({ product, quantity }) => ({ productId: product.id, quantity }))
        })
      });
      const order = await response.json();
      if (!response.ok) throw new Error(order.error || 'Не вдалося створити замовлення. Спробуйте ще раз.');
      const result = $('#checkoutResult');
      result.innerHTML = `<span class="result-icon">✓</span><span class="eyebrow">ЗАМОВЛЕННЯ ${escapeHTML(order.reference)}</span><h3>Переказ на картку</h3><p>Сплатіть точну суму, а продавець звірить надходження та оновить статус замовлення.</p><div class="payment-instructions"><div class="payment-instruction-row"><span>Отримувач</span><strong>ФОП Мільшин М.О.</strong></div><div class="payment-instruction-row"><span>Номер картки</span><div class="payment-value-with-action"><strong class="payment-card-number">4035 2000 4449 4893</strong><button class="copy-payment-value" type="button" data-copy-payment="4035200044494893">Копіювати</button></div></div><div class="payment-instruction-row payment-amount-row"><span>Сума до сплати</span><div class="payment-value-with-action"><strong>${money(order.amount)} ₴</strong><button class="copy-payment-value" type="button" data-copy-payment="${order.amount}">Копіювати</button></div></div><div class="payment-instruction-row"><span>Призначення</span><strong>${escapeHTML(order.reference)}</strong></div></div><p class="payment-manual-note">Це переказ за реквізитами, не автоматичне списання. Не вводьте на сайті номер картки, строк дії або CVV.</p><button class="button button-dark" type="button" id="closeResult">Повернутися до магазину </button>`;
      result.hidden = false;
      $('#checkoutForm').hidden = true;
      $('.checkout-heading').hidden = true;
      state.cart = {};
      saveStore(CART_KEY, state.cart);
      renderCart();
      $$('.copy-payment-value', result).forEach((button) => button.addEventListener('click', async () => {
        const value = button.dataset.copyPayment;
        try {
          await navigator.clipboard.writeText(value);
          button.textContent = 'Скопійовано';
        } catch {
          const input = document.createElement('textarea');
          input.value = value;
          input.setAttribute('readonly', '');
          input.style.position = 'fixed';
          input.style.opacity = '0';
          document.body.append(input);
          input.select();
          const copied = document.execCommand('copy');
          input.remove();
          button.textContent = copied ? 'Скопійовано' : 'Спробуйте ще раз';
        }
      }));
      $('#closeResult').addEventListener('click', () => {
        $('#checkoutDialog').close();
        $('#checkoutForm').reset();
        $('#checkoutForm').hidden = false;
        result.hidden = true;
      }, { once: true });
    } catch (error) {
      errorMessage.textContent = error.message;
      errorMessage.hidden = false;
    } finally {
      submitButton.disabled = false;
      submitButton.innerHTML = 'Створити замовлення ';
    }
  });

  $('#closePhotoZoom').addEventListener('click', () => $('#photoZoomDialog').close());
  $('#checkoutDialog').addEventListener('close', () => {
    if (!$('#checkoutResult').hidden) $('#checkoutForm').reset();
    $('#checkoutResult').hidden = true;
    $('#checkoutForm').hidden = false;
    $('.checkout-heading').hidden = false;
  });
  $('#photoZoomDialog').addEventListener('click', (event) => { if (event.target === $('#photoZoomDialog')) $('#photoZoomDialog').close(); });

  window.addEventListener('popstate', route);
}

async function init() {
  if (!state.cart || typeof state.cart !== 'object' || Array.isArray(state.cart)) state.cart = {};
  if (!Array.isArray(state.favorites)) state.favorites = [];
  $('#year').textContent = new Date().getFullYear();
  renderCart();
  setupEvents();
  try {
    const response = await fetch('/api/products', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Не вдалося завантажити каталог');
    state.products = (await response.json()).map((product) => ({ ...product, slug: slugify(product.name, product.id) }));
    state.favorites = state.favorites.filter((id, index, list) => productById(id) && list.indexOf(id) === index);
    state.cart = Object.fromEntries(Object.entries(state.cart).filter(([id, quantity]) => productById(id) && Number.isInteger(quantity) && quantity > 0 && quantity <= 50).slice(0, 25));
    renderCategories();
    renderHeroPhotoShowcase();
    renderCatalog();
    renderCart();
    route();
  } catch (error) {
    $('#resultsCount').textContent = 'Не вдалося завантажити товари. Оновіть сторінку трохи пізніше.';
    $('#loadMore').hidden = true;
    console.error(error);
  }
}

init();
