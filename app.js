const grid = document.querySelector("#sprite-grid");
const filtersElement = document.querySelector("#filters");
const countElement = document.querySelector("#sprite-count");
const searchInput = document.querySelector("#search");
const preview = document.querySelector("#preview");
const downloadButton = document.querySelector("#preview-download");
const downloadStatus = document.querySelector("#download-status");
const heroGrid = document.querySelector("#hero-grid");
const heroCount = document.querySelector("#hero-count");

let cards = [];
let activeLevel = "Wszystkie";

const levels = ["Wszystkie", "Poziom 1", "Poziom 2", "Poziom 3"];

async function loadCards() {
  const response = await fetch("cards.json");
  if (!response.ok) {
    throw new Error("Nie udało się wczytać cards.json");
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("cards.json musi zawierać tablicę kart");
  }

  return data;
}

async function loadHeroes() {
  const response = await fetch("heroes.json");
  if (!response.ok) {
    throw new Error("Nie udało się wczytać heroes.json");
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("heroes.json musi zawierać tablicę bohaterów");
  }

  return data;
}

function createHeroTile(hero) {
  const tile = document.createElement("article");
  const image = document.createElement("img");
  const sideBand = document.createElement("div");
  const points = document.createElement("span");
  const costs = document.createElement("div");

  tile.className = "hero-tile";
  tile.setAttribute("aria-label", hero.name);

  image.className = "hero-tile-image";
  image.src = hero.background;
  image.alt = hero.name;
  image.loading = "lazy";

  sideBand.className = "hero-tile-band";

  points.className = "hero-tile-points";
  points.textContent = Number(hero.victoryPoints) > 0
    ? hero.victoryPoints
    : "";

  costs.className = "hero-tile-costs";
  const resourceOrder = ["mercury", "gems", "sulfur", "crystal", "ore"];
  const costRows = resourceOrder
    .filter((resource) => Number(hero.cardCost?.[resource]) > 0)
    .map((resource) => {
      const chip = document.createElement("div");
      const icon = document.createElement("img");
      const amount = document.createElement("span");

      chip.className = "hero-cost-chip";
      chip.dataset.resource = resource;
      chip.setAttribute("aria-label", `${resource}: ${hero.cardCost[resource]}`);

      icon.className = "hero-cost-icon";
      icon.src = `sprites/resource/${resource}.png`;
      icon.alt = "";

      amount.className = "hero-cost-amount";
      amount.textContent = hero.cardCost[resource];

      chip.append(icon, amount);
      return chip;
    });
  costs.replaceChildren(...costRows);

  sideBand.append(points);
  tile.append(image, sideBand, costs);
  return tile;
}

async function initializeHeroes() {
  try {
    const heroes = await loadHeroes();
    heroCount.textContent = String(heroes.length).padStart(2, "0");
    heroGrid.replaceChildren(...heroes.map(createHeroTile));
  } catch (error) {
    console.error(error);
    heroCount.textContent = "00";
    const message = document.createElement("p");
    message.className = "hero-load-error";
    message.textContent = "Nie można wczytać heroes.json.";
    heroGrid.replaceChildren(message);
  }
}

function renderFilters() {
  const buttons = levels.map((level) => {
    const button = document.createElement("button");

    button.type = "button";
    button.className = `filter${level === activeLevel ? " active" : ""}`;
    button.textContent = level;
    button.setAttribute("aria-pressed", String(level === activeLevel));
    button.addEventListener("click", () => {
      activeLevel = level;
      renderFilters();
      renderCards();
    });

    return button;
  });

  filtersElement.replaceChildren(...buttons);
}

function openPreview(card) {
  const image = document.querySelector("#preview-image");
  const points = document.querySelector("#preview-points");
  const bonusResource = document.querySelector("#preview-bonus-resource");
  const cardCosts = document.querySelector("#preview-card-costs");

  image.src = card.background;
  image.alt = getCardLabel(card);
  points.textContent = Number(card.victoryPoints) === 0
    ? ""
    : card.victoryPoints;
  bonusResource.setAttribute(
    "href",
    `sprites/resource/${card.bonusResource}.png`,
  );
  cardCosts.replaceChildren(...createCardCostLayers(card.cost));
  preview.dataset.cardId = card.id || "card";
  points.setAttribute(
    "aria-label",
    `${card.victoryPoints} punktów zwycięstwa`,
  );
  preview.showModal();
}

async function downloadPreviewAsPng() {
  const imageElement = document.querySelector("#preview-image");
  const overlayElement = preview.querySelector(".card-overlay");
  const width = 1504;
  const height = 2080;

  downloadButton.disabled = true;
  downloadStatus.textContent = "Przygotowuję plik PNG…";

  try {
    await imageElement.decode();
    await document.fonts.load('italic 400 400px "Momentum"');
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const scale = Math.max(width / imageElement.naturalWidth, height / imageElement.naturalHeight);
    const drawnWidth = imageElement.naturalWidth * scale;
    const drawnHeight = imageElement.naturalHeight * scale;
    context.drawImage(imageElement, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);

    for (const layer of overlayElement.children) {
      if (layer.tagName.toLowerCase() === "rect") {
        context.save();
        context.globalAlpha = Number(layer.getAttribute("fill-opacity") || 1);
        context.fillStyle = layer.getAttribute("fill") || "white";
        context.fillRect(
          Number(layer.getAttribute("x") || 0),
          Number(layer.getAttribute("y") || 0),
          Number(layer.getAttribute("width") || 0),
          Number(layer.getAttribute("height") || 0),
        );
        context.restore();
      } else if (layer.tagName.toLowerCase() === "image") {
        await drawSvgImage(context, layer);
      } else if (layer.tagName.toLowerCase() === "text") {
        drawSvgText(context, layer);
      } else if (layer.tagName.toLowerCase() === "g") {
        for (const child of layer.children) {
          if (child.tagName.toLowerCase() === "image") {
            await drawSvgImage(context, child);
          } else if (child.tagName.toLowerCase() === "text") {
            drawSvgText(context, child);
          }
        }
      }
    }

    const pngBlob = await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Nie udało się utworzyć pliku PNG."));
      }, "image/png");
    });
    const pngUrl = URL.createObjectURL(pngBlob);
    const link = document.createElement("a");
    link.href = pngUrl;
    link.download = `${(preview.dataset.cardId || "card").replace(/[^a-z0-9_-]/gi, "-")}.png`;
    link.click();
    URL.revokeObjectURL(pngUrl);
    downloadStatus.textContent = "Karta została pobrana jako PNG.";
  } catch (error) {
    console.error(error);
    downloadStatus.textContent = "Nie udało się przygotować PNG.";
    window.alert("Nie udało się pobrać karty jako PNG. Sprawdź, czy wszystkie warstwy są dostępne.");
  } finally {
    downloadButton.disabled = false;
  }
}

async function drawSvgImage(context, layer) {
  const source = layer.getAttribute("href") || layer.getAttribute("xlink:href");
  if (!source) return;

  const image = new Image();
  image.src = new URL(source, document.baseURI).href;
  await image.decode();

  const x = Number(layer.getAttribute("x") || 0);
  const y = Number(layer.getAttribute("y") || 0);
  const width = Number(layer.getAttribute("width") || 0);
  const height = Number(layer.getAttribute("height") || 0);
  const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
  const drawnWidth = image.naturalWidth * scale;
  const drawnHeight = image.naturalHeight * scale;
  context.drawImage(
    image,
    x + (width - drawnWidth) / 2,
    y + (height - drawnHeight) / 2,
    drawnWidth,
    drawnHeight,
  );
}

function drawSvgText(context, element) {
  const text = element.textContent;
  if (!text) return;

  const fontSize = Number(element.getAttribute("font-size") || 16);
  const strokeWidth = element.classList.contains("card-cost-value") ? 14 : 24;
  context.save();
  context.font = `italic 400 ${fontSize}px Momentum, serif`;
  context.textAlign = element.getAttribute("text-anchor") === "middle" ? "center" : "start";
  context.textBaseline = "middle";
  context.lineJoin = "round";
  context.lineWidth = strokeWidth;
  context.strokeStyle = "#000";
  context.fillStyle = "#fff";
  const x = Number(element.getAttribute("x") || 0);
  const y = Number(element.getAttribute("y") || 0);
  context.strokeText(text, x, y);
  context.fillText(text, x, y);
  context.restore();
}

function getCardLabel(card) {
  return card.name || `Card ${card.id}`;
}

function createCardCostLayers(cost) {
  const svgNamespace = "http://www.w3.org/2000/svg";
  const resourceOrder = ["mercury", "gems", "sulfur", "crystal", "ore"];
  const usedResources = resourceOrder.filter((resource) => cost[resource] > 0);
  const orbSize = 300;
  const rowGap = 26;
  const left = 28;
  const bottomMargin = 32;
  const totalHeight = usedResources.length * orbSize +
    Math.max(0, usedResources.length - 1) * rowGap;
  const firstY = 2080 - bottomMargin - totalHeight;

  return usedResources.flatMap((resource, index) => {
    const y = firstY + index * (orbSize + rowGap);
    const orb = document.createElementNS(svgNamespace, "image");
    const resourceIcon = document.createElementNS(svgNamespace, "image");
    const amount = document.createElementNS(svgNamespace, "text");

    orb.setAttribute("class", "card-cost-orb");
    orb.setAttribute("href", `sprites/orbs/${resource}.png`);
    orb.setAttribute("x", String(left));
    orb.setAttribute("y", String(y));
    orb.setAttribute("width", String(orbSize));
    orb.setAttribute("height", String(orbSize));
    orb.setAttribute("preserveAspectRatio", "xMidYMid meet");

    const resourceIconSize = 190;
    resourceIcon.setAttribute("class", "card-cost-resource");
    resourceIcon.setAttribute("href", `sprites/resource/${resource}.png`);
    resourceIcon.setAttribute("x", String(left + orbSize - resourceIconSize / 2));
    resourceIcon.setAttribute("y", String(y + (orbSize - resourceIconSize) / 2));
    resourceIcon.setAttribute("width", String(resourceIconSize));
    resourceIcon.setAttribute("height", String(resourceIconSize));
    resourceIcon.setAttribute("preserveAspectRatio", "xMidYMid meet");

    amount.setAttribute("class", "card-overlay-points card-cost-value");
    amount.setAttribute("x", String(left + orbSize / 2 - 10));
    amount.setAttribute("y", String(y + orbSize / 2 - 10));
    amount.setAttribute("text-anchor", "middle");
    amount.setAttribute("dominant-baseline", "central");
    amount.setAttribute("font-size", "260");
    amount.textContent = cost[resource];

    return [orb, resourceIcon, amount];
  });
}

function createCardOverlay(pointsValue, bonusResource, cost) {
  const svgNamespace = "http://www.w3.org/2000/svg";
  const overlay = document.createElementNS(svgNamespace, "svg");
  const topBand = document.createElementNS(svgNamespace, "rect");
  const pointsText = document.createElementNS(svgNamespace, "text");
  const bonusIcon = document.createElementNS(svgNamespace, "image");
  const hasVictoryPoints = Number(pointsValue) !== 0;

  overlay.setAttribute("class", "card-overlay");
  overlay.setAttribute("viewBox", "0 0 1504 2080");
  overlay.setAttribute("preserveAspectRatio", "xMidYMid meet");
  overlay.setAttribute("role", "img");
  overlay.setAttribute(
    "aria-label",
    hasVictoryPoints
      ? `${pointsValue} punktów zwycięstwa, bonus: ${bonusResource}`
      : `bonus: ${bonusResource}`,
  );

  topBand.setAttribute("width", "1504");
  topBand.setAttribute("height", "416");
  topBand.setAttribute("fill", "white");
  topBand.setAttribute("fill-opacity", "0.7");

  pointsText.setAttribute("class", "card-overlay-points");
  pointsText.setAttribute("x", "180");
  pointsText.setAttribute("y", "190");
  pointsText.setAttribute("text-anchor", "middle");
  pointsText.setAttribute("dominant-baseline", "central");
  pointsText.setAttribute("font-size", "400");
  pointsText.textContent = pointsValue;

  bonusIcon.setAttribute("class", "card-bonus-resource");
  bonusIcon.setAttribute("href", `sprites/resource/${bonusResource}.png`);
  bonusIcon.setAttribute("x", "1070");
  bonusIcon.setAttribute("y", "28");
  bonusIcon.setAttribute("width", "360");
  bonusIcon.setAttribute("height", "360");
  bonusIcon.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const layers = [topBand];
  if (hasVictoryPoints) {
    layers.push(pointsText);
  }
  layers.push(bonusIcon, ...createCardCostLayers(cost));
  overlay.append(...layers);
  return overlay;
}

function createCardElement(card) {
  const button = document.createElement("button");
  const art = document.createElement("div");
  const image = document.createElement("img");
  button.type = "button";
  button.className = "sprite-card";
  button.setAttribute("aria-label", `Pokaż kartę: ${getCardLabel(card)}`);

  art.className = "sprite-art";
  image.src = card.background;
  image.alt = getCardLabel(card);
  image.loading = "lazy";

  art.append(
    image,
    createCardOverlay(card.victoryPoints, card.bonusResource, card.cost),
  );

  button.append(art);
  button.addEventListener("click", () => openPreview(card));

  return button;
}

function renderEmptyState() {
  const empty = document.createElement("div");
  const title = document.createElement("strong");
  const message = document.createElement("p");

  empty.className = "empty";
  title.textContent = "Nie znaleziono kart";
  message.textContent = "Zmień wyszukiwaną frazę albo wybierz inny poziom.";
  empty.append(title, message);
  grid.replaceChildren(empty);
}

function renderLoadError() {
  const empty = document.createElement("div");
  const title = document.createElement("strong");
  const message = document.createElement("p");

  empty.className = "empty";
  title.textContent = "Nie można wczytać cards.json";
  message.textContent =
    "Otwórz stronę przez serwer HTTP (np. GitHub Pages), a nie bezpośrednio jako plik.";
  empty.append(title, message);
  grid.replaceChildren(empty);
}

function renderCards() {
  const query = searchInput.value.trim().toLocaleLowerCase("pl");
  const visibleCards = cards.filter((card) => {
    const matchesLevel =
      activeLevel === "Wszystkie" || activeLevel === `Poziom ${card.tier}`;
    const searchableText = `${card.name || ""} ${card.id || ""}`
      .toLocaleLowerCase("pl");
    const matchesSearch = searchableText.includes(query);

    return matchesLevel && matchesSearch;
  });

  countElement.textContent = String(visibleCards.length).padStart(2, "0");

  if (visibleCards.length === 0) {
    renderEmptyState();
    return;
  }

  grid.replaceChildren(...visibleCards.map(createCardElement));
}

searchInput.addEventListener("input", renderCards);

document.querySelector("#preview-close").addEventListener("click", () => {
  preview.close();
});

downloadButton.addEventListener("click", downloadPreviewAsPng);

preview.addEventListener("click", (event) => {
  if (event.target === preview) {
    preview.close();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== searchInput) {
    event.preventDefault();
    searchInput.focus();
  }
});

async function initializeGallery() {
  try {
    cards = await loadCards();
    renderFilters();
    renderCards();
  } catch (error) {
    console.error(error);
    countElement.textContent = "00";
    renderLoadError();
  }
}

initializeGallery();
initializeHeroes();
