export function createHeroTile(hero, onSelect = null) {
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

  if (onSelect) {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "hero-tile-action";
    action.textContent = "Wybierz bohatera";
    action.addEventListener("click", onSelect);
    tile.tabIndex = 0;
    tile.append(action);
  }

  return tile;
}
