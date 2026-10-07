const svgNamespace = "http://www.w3.org/2000/svg";

export function createCardCostLayers(cost) {
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

export function createCardOverlay(pointsValue, bonusResource, cost) {
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
  if (hasVictoryPoints) layers.push(pointsText);
  layers.push(bonusIcon, ...createCardCostLayers(cost));
  overlay.append(...layers);
  return overlay;
}

export function createCardArtwork(card, className = "sprite-art") {
  const artwork = document.createElement("div");
  const image = document.createElement("img");

  artwork.className = className;
  image.src = card.background;
  image.alt = card.name || `Card ${card.id}`;
  image.loading = "lazy";
  artwork.append(image, createCardOverlay(card.victoryPoints, card.bonusResource, card.cost));
  return artwork;
}
