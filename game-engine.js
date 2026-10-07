export const resources = ["mercury", "gems", "sulfur", "crystal", "ore"];
export const tokenTypes = [...resources, "gold"];

export const resourceNames = {
  mercury: "Rtęć",
  gems: "Klejnoty",
  sulfur: "Siarka",
  crystal: "Kryształ",
  ore: "Ruda",
  gold: "Złoto",
};

export function emptyCounts(keys = tokenTypes) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

export function shuffle(items) {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }

  return result;
}

export function createLobby(user) {
  const member = { uid: user.uid, name: user.displayName || "Gracz" };

  return {
    status: "lobby",
    phase: "lobby",
    hostUid: user.uid,
    members: [member],
    memberUids: [user.uid],
    players: [createPlayer(member)],
    createdAt: Date.now(),
  };
}

function createPlayer(member) {
  return {
    uid: member.uid,
    name: member.name,
    tokens: emptyCounts(),
    bonuses: emptyCounts(resources),
    points: 0,
    boughtCardIds: [],
    reservedCount: 0,
    heroIds: [],
  };
}

export function createStartedGame(room, cards, heroes) {
  const playerCount = room.players.length;
  const regularTokenCount = playerCount === 2 ? 4 : playerCount === 3 ? 5 : 7;
  const bank = Object.fromEntries(resources.map((resource) => [resource, regularTokenCount]));
  bank.gold = 5;

  const decks = {};
  const market = {};

  for (const tier of [1, 2, 3]) {
    const deck = shuffle(cards.filter((card) => Number(card.tier) === tier).map((card) => String(card.id)));
    market[tier] = deck.splice(0, 4);
    decks[tier] = deck;
  }

  const heroDeck = shuffle(heroes.map((hero) => String(hero.id)));
  const availableHeroes = heroDeck.slice(0, playerCount + 1);
  const turnOrder = shuffle(room.players.map((player) => player.uid));

  return {
    ...room,
    status: "playing",
    phase: "action",
    bank,
    decks,
    market,
    availableHeroes,
    turnOrder,
    roundStarterUid: turnOrder[0],
    currentTurnUid: turnOrder[0],
    turnNumber: 1,
    triggerUid: null,
    pendingResolution: null,
    winnerUids: [],
    lastActionUid: room.hostUid,
    startedAt: Date.now(),
  };
}

export function getPlayer(game, uid) {
  const player = game.players.find((entry) => entry.uid === uid);
  if (!player) throw new Error("Nie należysz do tej partii.");
  return player;
}

export function getCard(cardMap, cardId) {
  const card = cardMap.get(String(cardId));
  if (!card) throw new Error("Nie można odnaleźć tej karty.");
  return card;
}

export function getHero(heroMap, heroId) {
  const hero = heroMap.get(String(heroId));
  if (!hero) throw new Error("Nie można odnaleźć tego bohatera.");
  return hero;
}

export function getCardCost(card, player) {
  return Object.fromEntries(resources.map((resource) => [
    resource,
    Math.max(0, Number(card.cost?.[resource] || 0) - Number(player.bonuses[resource] || 0)),
  ]));
}

export function getPayment(card, player) {
  const cost = getCardCost(card, player);
  const payment = emptyCounts();
  let goldNeeded = 0;

  for (const resource of resources) {
    const required = cost[resource];
    const regularPayment = Math.min(required, player.tokens[resource]);
    payment[resource] = regularPayment;
    goldNeeded += required - regularPayment;
  }

  payment.gold = goldNeeded;
  return goldNeeded <= player.tokens.gold ? payment : null;
}

export function eligibleHeroes(game, player, heroMap) {
  return game.availableHeroes.filter((heroId) => {
    const hero = getHero(heroMap, heroId);
    return resources.every((resource) => (
      Number(player.bonuses[resource] || 0) >= Number(hero.cardCost?.[resource] || 0)
    ));
  });
}

export function takeResources(game, uid, selectedResources, heroMap) {
  assertActionTurn(game, uid);

  const availableKinds = resources.filter((resource) => game.bank[resource] > 0).length;
  const requiredCount = Math.min(3, availableKinds);
  if (requiredCount === 0) throw new Error("W puli nie ma już surowców do dobrania.");
  if (!Array.isArray(selectedResources) || selectedResources.length !== requiredCount) {
    throw new Error(`Wybierz dokładnie ${requiredCount} różnych surowców.`);
  }

  if (new Set(selectedResources).size !== selectedResources.length ||
    selectedResources.some((resource) => !resources.includes(resource))) {
    throw new Error("Wybierz różne, prawidłowe surowce.");
  }

  for (const resource of selectedResources) {
    if (game.bank[resource] < 1) throw new Error("Tego surowca zabrakło w puli.");
    game.bank[resource] -= 1;
    getPlayer(game, uid).tokens[resource] += 1;
  }

  finishAction(game, uid, heroMap);
}

export function takeTwoResources(game, uid, resource, heroMap) {
  assertActionTurn(game, uid);
  if (!resources.includes(resource)) throw new Error("Nieprawidłowy surowiec.");
  if (game.bank[resource] < 4) throw new Error("Do tej akcji w puli muszą być co najmniej 4 takie znaczniki.");

  game.bank[resource] -= 2;
  getPlayer(game, uid).tokens[resource] += 2;
  finishAction(game, uid, heroMap);
}

export function reserveCard(game, uid, privateState, cardId, heroMap, tier = null) {
  assertActionTurn(game, uid);
  const player = getPlayer(game, uid);
  if (privateState.reservedCardIds.length >= 3) throw new Error("Możesz mieć najwyżej 3 zarezerwowane karty.");

  let selectedId = String(cardId ?? "");

  if (tier !== null) {
    const deck = game.decks[tier];
    if (!deck?.length) throw new Error("Ten stos kart jest pusty.");
    selectedId = deck.pop();
  } else {
    const faceUpCard = game.market[tierOfCard(game, selectedId)];
    if (!faceUpCard?.includes(selectedId)) throw new Error("Tej odkrytej karty nie ma już na stole.");
    removeFromMarket(game, selectedId);
  }

  privateState.reservedCardIds.push(selectedId);
  player.reservedCount = privateState.reservedCardIds.length;

  if (game.bank.gold > 0) {
    game.bank.gold -= 1;
    player.tokens.gold += 1;
  }

  finishAction(game, uid, heroMap);
}

export function buyCard(game, uid, privateState, cardMap, cardId, source, heroMap) {
  assertActionTurn(game, uid);
  const player = getPlayer(game, uid);
  const id = String(cardId);
  const card = getCard(cardMap, id);

  if (source === "market") {
    const tier = tierOfCard(game, id);
    if (!game.market[tier]?.includes(id)) throw new Error("Tej odkrytej karty nie ma już na stole.");
  } else if (source === "reserved") {
    if (!privateState.reservedCardIds.includes(id)) throw new Error("Ta karta nie jest zarezerwowana przez Ciebie.");
  } else {
    throw new Error("Nieprawidłowe źródło karty.");
  }

  const payment = getPayment(card, player);
  if (!payment) throw new Error("Brakuje zasobów do zakupu tej karty.");

  for (const tokenType of tokenTypes) {
    player.tokens[tokenType] -= payment[tokenType];
    game.bank[tokenType] += payment[tokenType];
  }

  player.bonuses[card.bonusResource] += 1;
  player.points += Number(card.victoryPoints || 0);
  player.boughtCardIds.push(id);

  if (source === "market") {
    removeFromMarket(game, id);
  } else {
    privateState.reservedCardIds = privateState.reservedCardIds.filter((reservedId) => reservedId !== id);
    player.reservedCount = privateState.reservedCardIds.length;
  }

  finishAction(game, uid, heroMap);
}

export function discardTokens(game, uid, selectedTokens, heroMap) {
  const pending = game.pendingResolution;
  if (game.phase !== "discard" || pending?.uid !== uid) throw new Error("Nie możesz teraz odrzucać znaczników.");
  const player = getPlayer(game, uid);
  const selectedTotal = tokenTypes.reduce((sum, type) => sum + Number(selectedTokens[type] || 0), 0);

  if (selectedTotal !== pending.count) throw new Error(`Odrzuć dokładnie ${pending.count} znaczników.`);

  for (const type of tokenTypes) {
    const amount = Number(selectedTokens[type] || 0);
    if (!Number.isInteger(amount) || amount < 0 || amount > player.tokens[type]) {
      throw new Error("Wybrane znaczniki są nieprawidłowe.");
    }
    player.tokens[type] -= amount;
    game.bank[type] += amount;
  }

  completeTurn(game, uid, null, heroMap);
}

export function selectHero(game, uid, heroId, heroMap) {
  const pending = game.pendingResolution;
  if (game.phase !== "hero" || pending?.uid !== uid || !pending.heroIds.includes(String(heroId))) {
    throw new Error("Ta płytka bohatera nie jest dostępna do wyboru.");
  }

  awardHero(game, uid, String(heroId));
  advanceTurn(game, uid);
}

export function completeTurn(game, uid, selectedHeroId, heroMap) {
  const player = getPlayer(game, uid);
  const candidates = eligibleHeroes(game, player, heroMap);
  game.lastActionUid = uid;

  if (candidates.length > 1 && !selectedHeroId) {
    game.phase = "hero";
    game.pendingResolution = { uid, heroIds: candidates.map(String) };
    return;
  }

  if (candidates.length === 1) {
    awardHero(game, uid, candidates[0]);
  } else if (selectedHeroId && candidates.map(String).includes(String(selectedHeroId))) {
    awardHero(game, uid, String(selectedHeroId));
  }

  advanceTurn(game, uid);
}

function finishAction(game, uid, heroMap) {
  const player = getPlayer(game, uid);
  const heldTokens = tokenTypes.reduce((sum, tokenType) => sum + player.tokens[tokenType], 0);
  game.lastActionUid = uid;

  if (heldTokens > 10) {
    game.phase = "discard";
    game.pendingResolution = { uid, count: heldTokens - 10 };
    return;
  }

  completeTurn(game, uid, null, heroMap);
}

function awardHero(game, uid, heroId) {
  const player = getPlayer(game, uid);
  game.availableHeroes = game.availableHeroes.filter((availableId) => String(availableId) !== String(heroId));
  player.heroIds.push(String(heroId));
  player.points += 3;
}

function advanceTurn(game, uid) {
  if (getPlayer(game, uid).points >= 15 && !game.triggerUid) {
    game.triggerUid = uid;
  }

  const currentIndex = game.turnOrder.indexOf(uid);
  const nextUid = game.turnOrder[(currentIndex + 1) % game.turnOrder.length];

  if (game.triggerUid && nextUid === game.triggerUid) {
    finishGame(game);
    return;
  }

  game.currentTurnUid = nextUid;
  game.turnNumber += 1;
  game.phase = "action";
  game.pendingResolution = null;
}

function finishGame(game) {
  const highestScore = Math.max(...game.players.map((player) => player.points));
  const topScorers = game.players.filter((player) => player.points === highestScore);
  const fewestCards = Math.min(...topScorers.map((player) => player.boughtCardIds.length));

  game.winnerUids = topScorers
    .filter((player) => player.boughtCardIds.length === fewestCards)
    .map((player) => player.uid);
  game.status = "finished";
  game.phase = "finished";
  game.pendingResolution = null;
}

function assertActionTurn(game, uid) {
  if (game.status !== "playing" || game.phase !== "action") throw new Error("Gra czeka na zakończenie bieżącej akcji.");
  if (game.currentTurnUid !== uid) throw new Error("Teraz nie jest Twoja tura.");
}

function tierOfCard(game, cardId) {
  return [1, 2, 3].find((tier) => game.market[tier]?.includes(String(cardId)));
}

function removeFromMarket(game, cardId) {
  const tier = tierOfCard(game, String(cardId));
  if (!tier) return;

  game.market[tier] = game.market[tier].filter((id) => id !== String(cardId));
  const nextCardId = game.decks[tier].pop();
  if (nextCardId) game.market[tier].push(nextCardId);
}

