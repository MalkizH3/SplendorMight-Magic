import { createCardCostLayers, createCardOverlay } from "./card-view.js";
import { createHeroTile } from "./hero-view.js";

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

async function initializeHeroes() {
  try {
    const heroes = await loadHeroes();
    heroCount.textContent = String(heroes.length).padStart(2, "0");
    heroGrid.replaceChildren(...heroes.map((hero) => createHeroTile(hero)));
  } catch (error) {
    console.error(error);
    heroCount.textContent = "00";
    const message = document.createElement("p");
    message.className = "hero-load-error";
    message.textContent = `Nie można wczytać heroes.json: ${error.message}`;
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
