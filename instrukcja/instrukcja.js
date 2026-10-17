import { createCardArtwork } from '../card-view.js';
import { createHeroTile } from '../hero-view.js';

const resources = [
  { id: 'sulfur', name: 'Siarka' },
  { id: 'gems', name: 'Klejnoty' },
  { id: 'crystal', name: 'Kryształ' },
  { id: 'mercury', name: 'Rtęć' },
  { id: 'ore', name: 'Ruda' },
];
const $ = (id) => document.getElementById(id);
const icon = (resource) => `<img src="sprites/resource/${resource}.png" alt="" />`;
const setResult = (id, text, success = false) => {
  $(id).textContent = text;
  $(id).classList.toggle('success', success);
};
const readCount = (id) => {
  const input = $(id);
  const value = Math.min(Number(input.max), Math.max(Number(input.min), Math.floor(Number(input.value) || 0)));
  return value;
};
// Clamp invalid numbers on leaving an input, while allowing normal editing.
document.addEventListener('change', (event) => {
  if (event.target.matches('input[type="number"]')) {
    event.target.value = readCount(event.target.id);
    updatePayment();
    updateHero();
  }
});

function updateSetup(players) {
  const count = players === 2 ? 4 : players === 3 ? 5 : 7;
  $('setup-resources').innerHTML = [...resources, { id: 'gold', name: 'Złoto' }].map((resource) => `<div class="resource-item">${icon(resource.id)}<span>${resource.name}</span><strong>${resource.id === 'gold' ? 5 : count}</strong></div>`).join('');
  $('setup-summary').textContent = `${players} graczy: po ${count} znaczników każdego z 5 surowców, 5 znaczników złota i ${players + 1} odkrytych bohaterów. ${players === 4 ? 'Użyj wszystkich 40 znaczników.' : `Odłóż po ${7 - count} znaczniki każdego surowca do pudełka.`}`;
  document.querySelectorAll('[data-players]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.players) === players)));
  const portraits = ['Christian', 'Styg', 'Gerwulf', 'Sandro', 'Octavia'];
  $('setup-heroes').innerHTML = portraits.slice(0, players + 1).map((name) => `<img src="sprites/heroes/${name}.png" alt="${name}" loading="lazy" />`).join('');
}
document.querySelectorAll('[data-players]').forEach((button) => button.addEventListener('click', () => updateSetup(Number(button.dataset.players))));
updateSetup(4);

// The market uses the same card renderer and data as the game.
async function renderMarket() {
  try {
    const response = await fetch('cards.json');
    if (!response.ok) throw new Error('Nie udało się wczytać kart.');
    const cards = await response.json();
    for (const tier of [3, 2, 1]) {
      const row = document.createElement('div');
      row.className = 'market-row';
      const label = document.createElement('span');
      label.textContent = ['I', 'II', 'III'][tier - 1];
      row.append(label);
      const tierCards = cards.filter((card) => card.tier === tier);
      [0, 4, 8, 12].forEach((index) => row.append(createCardArtwork(tierCards[index])));
      $('market-rows').append(row);
    }
  } catch {
    $('market-rows').textContent = 'Poziom III: 4 karty · Poziom II: 4 karty · Poziom I: 4 karty';
  }
}
renderMarket();

const tabs = [...document.querySelectorAll('[data-action]')];
function selectAction(button) {
  tabs.forEach((tab) => {
    const selected = tab === button;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $('action-' + tab.dataset.action).hidden = !selected;
  });
}
tabs.forEach((button, index) => {
  button.addEventListener('click', () => selectAction(button));
  button.addEventListener('keydown', (event) => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      selectAction(tabs[next]);
      tabs[next].focus();
    }
  });
});

const selectedResources = new Set();
$('take-resources').innerHTML = resources.map((resource) => `<button type="button" class="resource-button" data-take="${resource.id}" aria-pressed="false">${icon(resource.id)}<span>${resource.name}</span></button>`).join('');
function updateTake() {
  document.querySelectorAll('[data-take]').forEach((button) => button.setAttribute('aria-pressed', String(selectedResources.has(button.dataset.take))));
  const names = resources.filter((resource) => selectedResources.has(resource.id)).map((resource) => resource.name.toLowerCase());
  setResult('take-result', selectedResources.size === 3 ? `Prawidłowy ruch! Dobierasz po 1 znaczniku: ${names.join(', ')}. To cała twoja akcja.` : `Wybrano ${selectedResources.size} z 3 kolorów. Wybierz ${3 - selectedResources.size} ${selectedResources.size === 2 ? 'inny kolor' : 'różne kolory'}.`, selectedResources.size === 3);
}
document.querySelectorAll('[data-take]').forEach((button) => button.addEventListener('click', () => {
  const id = button.dataset.take;
  if (selectedResources.has(id)) selectedResources.delete(id);
  else if (selectedResources.size < 3) selectedResources.add(id);
  else {
    setResult('take-result', 'Masz już trzy kolory. Odznacz jeden z nich, aby wybrać inny.');
    return;
  }
  updateTake();
}));
$('reset-take').addEventListener('click', () => { selectedResources.clear(); updateTake(); });
updateTake();
function updateDouble() {
  const count = Number($('bank-count').value);
  $('bank-value').value = count;
  setResult('double-result', count >= 4 ? `Możesz dobrać 2 kryształy. W banku pozostanie ${count - 2}.` : `Nie możesz dobrać dwóch kryształów: w banku jest ich ${count}. Przed ruchem muszą być co najmniej 4.`, count >= 4);
}
$('bank-count').addEventListener('input', updateDouble);
updateDouble();
function updateReservation() {
  const count = Number($('reserved-count').value);
  const gold = $('gold-available').checked;
  setResult('reserve-result', count === 3 ? 'Nie możesz zarezerwować kolejnej karty. Masz już 3 na ręce — najpierw kup jedną z nich w osobnej turze.' : `Możesz zarezerwować kartę. Po ruchu masz ${count + 1} z 3 dozwolonych kart na ręce. ${gold ? 'Otrzymujesz też 1 złoto.' : 'Nie otrzymujesz złota, bo bank jest pusty. Rezerwacja nadal jest dozwolona.'}`, count < 3);
}
$('reserved-count').addEventListener('change', updateReservation);
$('gold-available').addEventListener('change', updateReservation);
updateReservation();

const sample = { id: 'example', name: 'Przykład: 2 punkty, bonus kryształu; koszt 1 rtęć, 4 klejnoty i 2 siarki', background: 'sprites/tier2/Crystal2-2.png', victoryPoints: 2, bonusResource: 'crystal', cost: { mercury: 1, gems: 4, sulfur: 2, crystal: 0, ore: 0 } };
$('purchase-card').replaceChildren(createCardArtwork(sample));
const paymentResources = [resources[3], resources[1], resources[0]];
$('calculator').innerHTML = '<div class="calc-row calc-head"><span>Surowiec</span><span>Koszt</span><span>Bonusy</span><span>Znaczniki</span><span>Do zapłaty</span></div>' + paymentResources.map((resource) => `<div class="calc-row"><span>${icon(resource.id)}${resource.name}</span><b>${sample.cost[resource.id]}</b><input type="number" id="bonus-${resource.id}" min="0" max="10" value="0" aria-label="Bonusy: ${resource.name}" /><input type="number" id="tokens-${resource.id}" min="0" max="10" value="${sample.cost[resource.id]}" aria-label="Twoje znaczniki: ${resource.name}" /><strong id="due-${resource.id}"></strong></div>`).join('');
function updatePayment() {
  let goldNeeded = 0;
  let totalDue = 0;
  let tokensHeld = readCount('gold-count');
  const payments = [];
  paymentResources.forEach((resource) => {
    const due = Math.max(0, sample.cost[resource.id] - readCount('bonus-' + resource.id));
    const tokens = readCount('tokens-' + resource.id);
    const used = Math.min(due, tokens);
    goldNeeded += due - used;
    totalDue += due;
    tokensHeld += tokens;
    $('due-' + resource.id).textContent = due;
    if (used) payments.push(`${resource.name.toLowerCase()}: ${used}`);
  });
  const gold = readCount('gold-count');
  if (tokensHeld > 10) {
    setResult('payment-result', `Masz ${tokensHeld} znaczników łącznie ze złotem. Między turami możesz mieć najwyżej 10 — zmniejsz ich liczbę, aby sprawdzić poprawny przykład.`);
  } else if (goldNeeded > gold) {
    setResult('payment-result', `Nie możesz jeszcze kupić tej karty. Po użyciu dostępnych znaczników brakuje ${goldNeeded} surowców. Masz ${gold} złota — potrzebujesz jeszcze ${goldNeeded - gold}. Bonusy i znaczniki innych kolorów nie pokrywają tego braku.`);
  } else if (totalDue === 0) {
    setResult('payment-result', 'Darmowy zakup! Twoje bonusy pokrywają cały koszt. Nie wydajesz żadnych znaczników. Dostajesz 2 punkty i stały bonus kryształu. Zakup nadal zajmuje jedną akcję.', true);
  } else {
    if (goldNeeded) payments.push(`złoto: ${goldNeeded}`);
    setResult('payment-result', `Możesz kupić kartę. Oddajesz do banku: ${payments.join(' · ')}. Dostajesz 2 punkty i stały bonus kryształu. Twoje dotychczasowe bonusy zostają.`, true);
  }
}
$('calculator').addEventListener('input', updatePayment);
$('gold-count').addEventListener('input', updatePayment);
$('reset-payment').addEventListener('click', () => {
  paymentResources.forEach((resource) => { $('bonus-' + resource.id).value = 0; $('tokens-' + resource.id).value = sample.cost[resource.id]; });
  $('gold-count').value = 0;
  updatePayment();
});
updatePayment();

const heroResources = [resources[0], resources[1], resources[3]];
$('hero-bonuses').innerHTML = heroResources.map((resource) => `<label for="hero-${resource.id}">${icon(resource.id)}${resource.name}<input type="number" id="hero-${resource.id}" min="0" max="10" value="2" aria-label="Bonusy dla bohatera: ${resource.name}" /><span>potrzeba 3</span></label>`).join('');
function updateHero() {
  const missing = heroResources.filter((resource) => readCount('hero-' + resource.id) < 3);
  setResult('hero-result', missing.length ? `Jeszcze za wcześnie na wizytę. Brakujące bonusy: ${missing.map((resource) => `${resource.name.toLowerCase()} ${3 - readCount('hero-' + resource.id)}`).join(' · ')}.` : 'Styg odwiedza twoje królestwo! Weź jego płytkę i dodaj 3 punkty. Bonusy pozostają z tobą. W tej turze nie możesz już przyjąć drugiego bohatera.', !missing.length);
}
$('hero-bonuses').addEventListener('input', updateHero);
updateHero();

// Render the example with the same component and hero data as the game.
async function renderStyg() {
  const response = await fetch('heroes.json');
  if (!response.ok) throw new Error('Nie udało się wczytać bohatera.');
  const heroes = await response.json();
  const styg = heroes.find((hero) => hero.name === 'Styg');
  if (!styg) throw new Error('Brak Styga w katalogu bohaterów.');
  $('styg-tile').replaceChildren(createHeroTile(styg));
}
renderStyg().catch(() => {
  $('styg-tile').textContent = 'Styg · 3 punkty · wymagania: 3 rtęci, 3 klejnotów, 3 siarki';
});
