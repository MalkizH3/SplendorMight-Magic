import {
  auth,
  collection,
  db,
  doc,
  getDoc,
  onAuthStateChanged,
  onDisconnect,
  onSnapshot,
  onValue,
  ref,
  realtimeDb,
  runTransaction,
  serverTimestamp,
  set,
  setDoc,
  writeBatch,
  signInWithPopup,
  signOut,
  GoogleAuthProvider,
  firebaseReady,
  firebasePresenceReady,
} from "./firebase-client.js";
import {
  buyCard,
  createLobby,
  createStartedGame,
  discardTokens,
  emptyCounts,
  getCard,
  getHero,
  getPayment,
  resourceNames,
  resources,
  reserveCard,
  selectHero,
  takeResources,
  takeTwoResources,
  tokenTypes,
} from "./game-engine.js";
import { createCardArtwork } from "./card-view.js";
import { createHeroTile } from "./hero-view.js";

const elements = Object.fromEntries([
  "game-connection", "game-message", "game-section", "game-back-button",
  "auth-panel", "sign-in-button", "sign-out-button",
  "game-profile", "profile-name", "lobby-panel", "lobby-home", "lobby-resume",
  "return-to-game-button", "leave-game-button", "create-room-button",
  "room-lobby", "lobby-player-count", "lobby-player-list", "invite-link",
  "copy-invite-button", "leave-room-button", "start-game-button", "lobby-hint",
  "game-board", "turn-label", "turn-status", "round-status", "game-players",
  "market-tiers", "bank-resources", "game-actions", "game-heroes",
  "game-resolution", "discard-dialog", "game-finished",
].map((id) => [id, document.getElementById(id)]));

let cards = [];
let heroes = [];
let cardMap = new Map();
let heroMap = new Map();
let currentUser = null;
let currentRoomId = null;
let currentRoom = null;
let activeScreen = "home";
let ownPrivateState = { reservedCardIds: [] };
let stopRoomListener = null;
let stopPrivateListener = null;
let stopPresenceConnection = null;
const presenceListeners = new Map();
const presenceByUid = new Map();
let currentPresenceRoom = null;
let discardSelection = emptyCounts();
let discardSelectionKey = "";
let selectedResourcePicks = [];
let resourceBankSnapshot = null;
let inviteAttempted = false;

const cardResourceOrder = ["mercury", "gems", "sulfur", "crystal", "ore"];

function showMessage(message, kind = "info") {
  elements["game-message"].textContent = message;
  elements["game-message"].dataset.kind = kind;
  elements["game-message"].hidden = !message;
}

function setConnection(message, status) {
  elements["game-connection"].textContent = message;
  elements["game-connection"].dataset.status = status;
}

function roomReference(roomId = currentRoomId) {
  if (!roomId) throw new Error("Nie wybrano pokoju.");
  return doc(db, "rooms", roomId);
}

function privateReference(roomId = currentRoomId, uid = currentUser.uid) {
  return doc(db, "rooms", roomId, "private", uid);
}

function inviteUrl(roomId) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  return url.href;
}

function setRoomUrl(roomId) {
  const url = new URL(window.location.href);
  if (roomId) url.searchParams.set("room", roomId);
  else url.searchParams.delete("room");
  window.history.replaceState({}, "", url);
}

function stopRoomSubscriptions() {
  stopRoomListener?.();
  stopPrivateListener?.();
  stopRoomListener = null;
  stopPrivateListener = null;
  stopPresenceConnection?.();
  stopPresenceConnection = null;
  for (const stop of presenceListeners.values()) stop();
  presenceListeners.clear();
  presenceByUid.clear();
  currentPresenceRoom = null;
}

function watchRoom(roomId) {
  stopRoomSubscriptions();
  currentRoomId = roomId;
  setRoomUrl(roomId);
  stopRoomListener = onSnapshot(roomReference(roomId), async (snapshot) => {
    if (!snapshot.exists()) {
      let closure = null;
      try {
        const closureSnapshot = await getDoc(doc(db, "roomClosures", roomId));
        if (closureSnapshot.exists()) closure = closureSnapshot.data();
      } catch (error) {
        console.error(error);
      }
      if (currentRoomId !== roomId) return;

      currentRoom = null;
      leaveRoomView();
      if (closure?.closedByUid && closure.closedByUid !== currentUser?.uid) {
        window.alert(`Zakończono: gracz ${closure.closedByName || "Gracz"} opuścił grę.`);
      } else if (closure?.closedByUid === currentUser?.uid) {
        showMessage("Partia została zamknięta i usunięta dla wszystkich graczy.");
      } else {
        showMessage("Partia została zamknięta.");
      }
      return;
    }

    currentRoom = { id: snapshot.id, ...snapshot.data() };
    syncPresenceWatchers();
    renderGame();
  }, (error) => {
    console.error(error);
    showMessage("Nie udało się połączyć z pokojem. Odśwież stronę i spróbuj ponownie.", "error");
  });

  stopPrivateListener = onSnapshot(privateReference(roomId), (snapshot) => {
    ownPrivateState = snapshot.exists()
      ? snapshot.data()
      : { reservedCardIds: [] };
    renderGame();
  }, (error) => {
    console.error(error);
    showMessage("Nie można odczytać Twoich zarezerwowanych kart.", "error");
  });

  watchOwnPresence(roomId);
}

function watchOwnPresence(roomId) {
  if (!realtimeDb || !currentUser) return;
  const connectionReference = ref(realtimeDb, ".info/connected");
  const ownReference = ref(realtimeDb, `presence/${roomId}/${currentUser.uid}`);

  stopPresenceConnection = onValue(connectionReference, async (snapshot) => {
    if (!snapshot.val()) return;

    try {
      await onDisconnect(ownReference).set({
        state: "offline",
        changedAt: serverTimestamp(),
      });
      await set(ownReference, {
        state: "online",
        changedAt: serverTimestamp(),
      });
    } catch (error) {
      console.error(error);
      setConnection("Błąd statusu połączenia", "error");
    }
  });
}

function syncPresenceWatchers() {
  if (!currentRoom || !realtimeDb) return;
  if (currentPresenceRoom !== currentRoomId) {
    for (const stop of presenceListeners.values()) stop();
    presenceListeners.clear();
    presenceByUid.clear();
    currentPresenceRoom = currentRoomId;
  }

  const memberIds = new Set(currentRoom.members.map((member) => member.uid));

  for (const [uid, stop] of presenceListeners) {
    if (!memberIds.has(uid)) {
      stop();
      presenceListeners.delete(uid);
      presenceByUid.delete(uid);
    }
  }

  for (const member of currentRoom.members) {
    if (presenceListeners.has(member.uid)) continue;
    const presenceReference = ref(realtimeDb, `presence/${currentRoomId}/${member.uid}`);
    const stop = onValue(presenceReference, (snapshot) => {
      presenceByUid.set(member.uid, snapshot.val()?.state || "offline");
      renderGame();
    });
    presenceListeners.set(member.uid, stop);
  }
}

function everyoneIsOnline() {
  if (!firebasePresenceReady) return navigator.onLine;
  return Boolean(currentRoom?.members.length) && currentRoom.members.every((member) => (
    presenceByUid.get(member.uid) === "online"
  ));
}

function currentGamePlayer() {
  return currentRoom?.players.find((player) => player.uid === currentUser?.uid);
}

function isMyTurn() {
  return currentRoom?.currentTurnUid === currentUser?.uid && everyoneIsOnline();
}

async function initializeGameData() {
  try {
    const [cardsResponse, heroesResponse] = await Promise.all([
      fetch("cards.json"),
      fetch("heroes.json"),
    ]);
    if (!cardsResponse.ok || !heroesResponse.ok) throw new Error("Nie można pobrać danych kart i bohaterów.");
    cards = await cardsResponse.json();
    heroes = await heroesResponse.json();
    cardMap = new Map(cards.map((card) => [String(card.id), card]));
    heroMap = new Map(heroes.map((hero) => [String(hero.id), hero]));
  } catch (error) {
    console.error(error);
    showMessage("Nie udało się wczytać cards.json lub heroes.json. Uruchom stronę przez serwer HTTP.", "error");
  }
}

function setSignedIn(user) {
  currentUser = user;
  elements["auth-panel"].classList.toggle("is-signed-in", Boolean(user));
  elements["game-profile"].hidden = !user;
  elements["sign-in-button"].hidden = Boolean(user);
  elements["profile-name"].textContent = user?.displayName || user?.email || "Gracz";
}

async function createRoom() {
  if (!currentUser) return;
  showMessage("");

  try {
    const roomRef = doc(collection(db, "rooms"));
    const room = createLobby(currentUser);
    const privateRef = privateReference(roomRef.id, currentUser.uid);

    const batch = writeBatch(db);
    batch.set(roomRef, room);
    batch.set(privateRef, { reservedCardIds: [] });
    await batch.commit();

    activeScreen = "home";
    watchRoom(roomRef.id);
  } catch (error) {
    console.error(error);
    showMessage(firebaseErrorMessage(error), "error");
  }
}

async function joinRoom(roomId) {
  if (!currentUser || !roomId || currentRoomId === roomId) return;
  showMessage("");

  try {
    const roomRef = roomReference(roomId);
    const ownRef = privateReference(roomId, currentUser.uid);

    let roomStatus = "lobby";
    await runTransaction(db, async (transaction) => {
      const roomSnapshot = await transaction.get(roomRef);
      if (!roomSnapshot.exists()) throw new Error("Nie znaleziono pokoju z tego linku.");
      const room = roomSnapshot.data();
      roomStatus = room.status;
      const isMember = room.members.some((member) => member.uid === currentUser.uid);

      if (!isMember) {
        if (room.status !== "lobby") throw new Error("Partia już się rozpoczęła; dołączają tylko jej uczestnicy.");
        if (room.members.length >= 4) throw new Error("W pokoju jest już maksymalnie 4 graczy.");

        const member = {
          uid: currentUser.uid,
          name: currentUser.displayName || "Gracz",
        };
        room.members.push(member);
        room.memberUids.push(member.uid);
        room.players.push({
          uid: member.uid,
          name: member.name,
          tokens: emptyCounts(),
          bonuses: emptyCounts(resources),
          points: 0,
          boughtCardIds: [],
          reservedCount: 0,
          heroIds: [],
        });
        transaction.set(roomRef, room);
        transaction.set(ownRef, { reservedCardIds: [] });
      }
    });

    const privateSnapshot = await getDoc(ownRef);
    if (!privateSnapshot.exists()) await setDoc(ownRef, { reservedCardIds: [] });
    activeScreen = roomStatus === "lobby" ? "home" : "game";
    watchRoom(roomId);
  } catch (error) {
    console.error(error);
    showMessage(firebaseErrorMessage(error), "error");
  }
}

async function startGame() {
  if (!currentRoomId || !currentRoom || currentRoom.hostUid !== currentUser.uid) return;
  if (!everyoneIsOnline()) {
    showMessage("Poczekaj, aż wszyscy gracze połączą się z pokojem.", "error");
    return;
  }

  try {
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(roomReference());
      if (!snapshot.exists()) throw new Error("Pokój już nie istnieje.");
      const room = snapshot.data();
      if (room.hostUid !== currentUser.uid) throw new Error("Tylko gospodarz może rozpocząć partię.");
      if (room.status !== "lobby") throw new Error("Ta partia została już rozpoczęta.");
      if (room.members.length < 2 || room.members.length > 4) throw new Error("Do gry potrzeba od 2 do 4 osób.");
      transaction.set(roomReference(), createStartedGame(room, cards, heroes));
    });
    activeScreen = "game";
    showMessage("");
    renderGame();
  } catch (error) {
    console.error(error);
    showMessage(firebaseErrorMessage(error), "error");
  }
}

async function updateGame(mutator) {
  if (!currentRoomId || !currentUser) throw new Error("Zaloguj się, aby wykonać ruch.");
  if (!everyoneIsOnline()) throw new Error("Gra czeka na połączenie wszystkich uczestników.");
  const gameRef = roomReference();
  const ownRef = privateReference();

  return runTransaction(db, async (transaction) => {
    const [gameSnapshot, privateSnapshot] = await Promise.all([
      transaction.get(gameRef),
      transaction.get(ownRef),
    ]);
    if (!gameSnapshot.exists()) throw new Error("Pokój już nie istnieje.");

    const game = gameSnapshot.data();
    const privateState = privateSnapshot.exists()
      ? privateSnapshot.data()
      : { reservedCardIds: [] };
    mutator(game, privateState);
    transaction.set(gameRef, game);
    transaction.set(ownRef, privateState);
    return game;
  });
}

async function performAction(mutator) {
  try {
    showMessage("");
    const updatedRoom = await updateGame((game, privateState) => {
      if (game.currentTurnUid !== currentUser.uid) throw new Error("Teraz nie jest Twoja tura.");
      mutator(game, privateState);
    });
    currentRoom = { ...currentRoom, ...updatedRoom };
    selectedResourcePicks = [];
    resourceBankSnapshot = null;
    if (currentRoom?.status === "playing") renderBoard();
  } catch (error) {
    console.error(error);
    showMessage(firebaseErrorMessage(error), "error");
  }
}

function renderGame() {
  const hasRoom = Boolean(currentRoom && currentUser);
  const isStarted = hasRoom && currentRoom.status !== "lobby";
  const showGameScreen = activeScreen === "game" && isStarted;
  document.body.classList.toggle("is-game-screen", showGameScreen);
  elements["game-back-button"].hidden = !showGameScreen;
  elements["auth-panel"].hidden = Boolean(currentUser) || showGameScreen;
  elements["lobby-panel"].hidden = !currentUser || showGameScreen;
  elements["lobby-home"].hidden = hasRoom;
  elements["room-lobby"].hidden = !hasRoom || currentRoom.status !== "lobby";
  elements["lobby-resume"].hidden = !isStarted;
  elements["game-board"].hidden = !showGameScreen;

  if (!currentUser) return;
  if (!currentRoom) return;

  if (currentRoom.status === "lobby") renderLobby();
  else renderBoard();
}

function renderLobby() {
  const isHost = currentRoom.hostUid === currentUser.uid;
  const connectedCount = firebasePresenceReady
    ? currentRoom.members.filter((member) => presenceByUid.get(member.uid) === "online").length
    : navigator.onLine ? currentRoom.members.length : 0;

  elements["lobby-player-count"].textContent = `(${currentRoom.members.length}/4)`;
  elements["invite-link"].value = inviteUrl(currentRoomId);
  elements["lobby-player-list"].replaceChildren(...currentRoom.members.map((member, index) => {
    const row = document.createElement("li");
    const name = document.createElement("span");
    const presence = document.createElement("span");
    name.textContent = `${member.name}${member.uid === currentUser.uid ? " (Ty)" : ""}`;
    presence.className = "player-presence";
    const isOnline = firebasePresenceReady
      ? presenceByUid.get(member.uid) === "online"
      : navigator.onLine;
    presence.dataset.online = String(isOnline);
    presence.textContent = firebasePresenceReady
      ? isOnline ? "Połączony" : "Oczekiwanie"
      : "Brak monitorowania";
    row.append(name, presence);
    if (index === 0 || member.uid === currentRoom.hostUid) {
      const host = document.createElement("small");
      host.textContent = "Gospodarz";
      row.append(host);
    }
    return row;
  }));

  elements["start-game-button"].hidden = !isHost;
  elements["start-game-button"].disabled = currentRoom.members.length < 2 ||
    currentRoom.members.length > 4 || connectedCount !== currentRoom.members.length;
  elements["lobby-hint"].textContent = !firebasePresenceReady
    ? "Logowanie i zapis partii są dostępne. Dodaj databaseURL Realtime Database, aby monitorować połączenia graczy."
    : currentRoom.members.length < 2
    ? "Potrzeba co najmniej dwóch graczy. Skopiuj link i zaproś znajomego."
    : connectedCount !== currentRoom.members.length
      ? "Gra rozpocznie się, gdy wszyscy będą połączeni."
      : isHost
        ? "Wszyscy są gotowi. Gospodarz może rozpocząć partię."
        : "Czekaj na rozpoczęcie partii przez gospodarza.";
  elements["leave-room-button"].hidden = false;
  updateConnectionLabel();
}

function renderBoard() {
  const paused = !everyoneIsOnline() && currentRoom.status === "playing";
  const activePlayer = currentRoom.players.find((player) => player.uid === currentRoom.currentTurnUid);
  const isMine = currentRoom.currentTurnUid === currentUser.uid;
  elements["leave-room-button"].hidden = true;
  elements["turn-label"].textContent = currentRoom.status === "finished" ? "KONIEC GRY" : "TURA";
  elements["turn-status"].textContent = currentRoom.status === "finished"
    ? "Partia zakończona"
    : paused
      ? "Gra wstrzymana — oczekiwanie na graczy"
      : currentRoom.phase === "discard"
        ? isMine ? "Odrzuć nadmiar znaczników" : `Czeka na ${activePlayer?.name}`
        : currentRoom.phase === "hero"
          ? isMine ? "Wybierz bohatera" : `Czeka na ${activePlayer?.name}`
          : isMine ? "Twoja tura" : `Ruch gracza: ${activePlayer?.name || "—"}`;
  elements["round-status"].textContent = currentRoom.turnNumber
    ? `Ruch ${currentRoom.turnNumber}`
    : "";

  renderPlayers();
  renderMarket(paused);
  renderBank(paused);
  renderActions(paused);
  renderHeroes(paused);
  renderResolution(paused);
  renderFinished();
  updateConnectionLabel(paused);
}

function renderPlayers() {
  elements["game-players"].replaceChildren(...currentRoom.players.map((player) => {
    const card = document.createElement("article");
    const heading = document.createElement("div");
    const name = document.createElement("strong");
    const score = document.createElement("span");
    const resourceList = document.createElement("div");

    card.className = "game-player-card";
    if (player.uid === currentRoom.currentTurnUid && currentRoom.status === "playing") {
      card.classList.add("is-active");
    }
    name.textContent = player.uid === currentUser.uid ? `${player.name} (Ty)` : player.name;
    score.className = "player-score";
    score.textContent = `${player.points} pkt`;
    heading.className = "game-player-heading";
    heading.append(name, score);
    resourceList.className = "player-bonuses";

    for (const resource of resources) {
      const bonus = document.createElement("span");
      bonus.className = "bonus-count";
      const icon = makeResourceIcon(resource);
      const number = document.createElement("b");
      icon.alt = "";
      number.textContent = player.bonuses[resource];
      bonus.append(icon, number);
      resourceList.append(bonus);
    }

    const tokens = document.createElement("div");
    tokens.className = "player-tokens";
    for (const type of tokenTypes) {
      const token = document.createElement("span");
      const count = document.createElement("b");
      token.className = "player-token";
      token.title = resourceNames[type];
      count.textContent = String(player.tokens[type]);
      token.append(makeResourceIcon(type), count);
      tokens.append(token);
    }

    const ownedCards = document.createElement("div");
    ownedCards.className = "player-visible-cards";
    for (const cardId of player.boughtCardIds) {
      const ownedCard = getCard(cardMap, cardId);
      ownedCards.append(makePlayerCardBadge(ownedCard));
    }

    const reservations = document.createElement("section");
    const reservationHeading = document.createElement("div");
    const reservationLabel = document.createElement("span");
    const reservationCount = document.createElement("strong");
    const reservationCards = document.createElement("div");
    reservations.className = "player-reservations";
    reservationHeading.className = "player-reservations-heading";
    reservationLabel.textContent = "Zarezerwowane";
    reservationCount.textContent = `(${player.reservedCount}/3)`;
    reservationCards.className = "player-visible-reservations";
    reservationHeading.append(reservationLabel, reservationCount);

    if (player.uid === currentUser.uid) {
      for (const cardId of ownPrivateState.reservedCardIds) {
        reservationCards.append(makePlayerCardBadge(getCard(cardMap, cardId), true));
      }
    }
    reservations.append(reservationHeading, reservationCards);

    const ownedHeroes = document.createElement("div");
    ownedHeroes.className = "player-visible-heroes";
    for (const heroId of player.heroIds) {
      const heroName = document.createElement("span");
      heroName.textContent = getHero(heroMap, heroId).name;
      ownedHeroes.append(heroName);
    }
    card.append(heading, tokens, resourceList, ownedCards, reservations, ownedHeroes);
    return card;
  }));
}

function makePlayerCardBadge(card, isReserved = false) {
  const badge = document.createElement("div");
  const display = document.createElement("div");
  const hoverCard = document.createElement("div");
  const points = document.createElement("strong");
  const bonusIcon = makeResourceIcon(card.bonusResource);

  badge.className = "player-visible-card";
  badge.tabIndex = 0;
  badge.setAttribute(
    "aria-label",
    `${card.victoryPoints} punktów, bonus: ${resourceNames[card.bonusResource]}`,
  );
  display.className = "player-card-display";
  points.className = "player-card-points";
  points.textContent = String(card.victoryPoints);
  bonusIcon.classList.add("player-card-bonus-icon");
  bonusIcon.alt = resourceNames[card.bonusResource];
  display.append(points, bonusIcon);
  hoverCard.className = "player-card-hover-card";
  hoverCard.append(createCardArtwork(card, "sprite-art player-card-hover-preview"));

  if (isReserved && isMyTurn() && currentRoom.phase === "action") {
    const buyButton = makeButton("Kup", "game-button game-button-primary player-card-hover-buy");
    const player = currentRoom.players.find((entry) => entry.uid === currentUser.uid);
    buyButton.disabled = !getPayment(card, player);
    buyButton.addEventListener("click", () => performAction((game, privateState) => {
      buyCard(game, currentUser.uid, privateState, cardMap, card.id, "reserved", heroMap);
    }));
    hoverCard.append(buyButton);
  }

  badge.append(display, hoverCard);
  return badge;
}

function renderMarket(paused) {
  elements["market-tiers"].replaceChildren(...[3, 2, 1].map((tier) => {
    const row = document.createElement("section");
    const tierInfo = document.createElement("div");
    const heading = document.createElement("h4");
    const deckCount = document.createElement("span");
    const reserveButton = makeButton(
      "Rezerwuj zakrytą",
      "game-button game-button-small reserve-deck-button",
    );
    const cardsGrid = document.createElement("div");
    const player = currentRoom.players.find((entry) => entry.uid === currentUser.uid);

    row.className = "market-tier";
    tierInfo.className = "market-tier-info";
    heading.textContent = `Poziom ${tier}`;
    deckCount.className = "market-deck-count";
    deckCount.textContent = `Talia: ${currentRoom.decks[tier].length}`;
    reserveButton.disabled = !isMyTurn() || paused || currentRoom.phase !== "action" ||
      currentRoom.decks[tier].length === 0 || player.reservedCount >= 3;
    reserveButton.addEventListener("click", () => performAction((game, privateState) => {
      reserveCard(game, currentUser.uid, privateState, null, heroMap, tier);
    }));
    cardsGrid.className = "market-card-list";
    tierInfo.append(heading, deckCount, reserveButton);
    row.append(tierInfo, cardsGrid);

    for (const cardId of currentRoom.market[tier]) {
      const gameCard = getCard(cardMap, cardId);
      cardsGrid.append(makeMarketCard(gameCard));
    }

    if (!currentRoom.market[tier].length) {
      const empty = document.createElement("p");
      empty.className = "market-empty";
      empty.textContent = "Brak kart";
      cardsGrid.append(empty);
    }

    return row;
  }));
}

function makeMarketCard(card) {
  const article = document.createElement("article");
  const artwork = createCardArtwork(card, "market-card-art");
  const actions = document.createElement("div");
  const player = currentRoom.players.find((entry) => entry.uid === currentUser.uid);
  const canBuy = Boolean(getPayment(card, player));

  article.className = "market-card";
  article.setAttribute("aria-label", `Karta ${card.id}`);
  article.tabIndex = 0;
  actions.className = "market-card-actions";

  const buyButton = makeButton("Kup", "game-button game-button-small game-button-primary");
  buyButton.disabled = !isMyTurn() || currentRoom.phase !== "action" || !canBuy;
  buyButton.addEventListener("click", () => performAction((game, privateState) => {
    buyCard(game, currentUser.uid, privateState, cardMap, card.id, "market", heroMap);
  }));
  actions.append(buyButton);

  const reserveButton = makeButton("Rezerwuj", "game-button game-button-small");
  reserveButton.disabled = !isMyTurn() || currentRoom.phase !== "action" || player.reservedCount >= 3;
  reserveButton.addEventListener("click", () => performAction((game, privateState) => {
    reserveCard(game, currentUser.uid, privateState, card.id, heroMap);
  }));
  actions.append(reserveButton);

  article.append(artwork, actions);
  return article;
}

function makeTableCard(card, source) {
  const article = document.createElement("article");
  const image = document.createElement("img");
  const details = document.createElement("div");
  const points = document.createElement("span");
  const bonus = document.createElement("span");
  const cost = document.createElement("div");
  const actions = document.createElement("div");

  article.className = "table-card";
  image.className = "table-card-art";
  image.src = card.background;
  image.alt = "";
  image.loading = "lazy";
  details.className = "table-card-details";
  points.className = "table-card-points";
  points.textContent = `${card.victoryPoints} pkt`;
  bonus.className = "table-card-bonus";
  bonus.append(makeResourceIcon(card.bonusResource), document.createTextNode(resourceNames[card.bonusResource]));
  cost.className = "table-card-cost";
  for (const resource of cardResourceOrder) {
    if (Number(card.cost[resource]) < 1) continue;
    const item = document.createElement("span");
    item.className = "table-cost-item";
    item.append(makeResourceIcon(resource), document.createTextNode(String(card.cost[resource])));
    cost.append(item);
  }

  actions.className = "table-card-actions";
  const buyButton = makeButton("Kup", "game-button game-button-small game-button-primary");
  const canBuy = Boolean(getPayment(card, currentRoom.players.find((player) => player.uid === currentUser.uid)));
  buyButton.disabled = !isMyTurn() || currentRoom.phase !== "action" || !canBuy;
  buyButton.addEventListener("click", () => performAction((game, privateState) => {
    buyCard(game, currentUser.uid, privateState, cardMap, card.id, source, heroMap);
  }));
  actions.append(buyButton);

  if (source === "market") {
    const reserveButton = makeButton("Rezerwuj", "game-button game-button-small");
    reserveButton.disabled = !isMyTurn() || currentRoom.phase !== "action" ||
      currentRoom.players.find((player) => player.uid === currentUser.uid).reservedCount >= 3;
    reserveButton.addEventListener("click", () => performAction((game, privateState) => {
      reserveCard(game, currentUser.uid, privateState, card.id, heroMap);
    }));
    actions.append(reserveButton);
  }

  details.append(points, bonus, cost, actions);
  article.append(image, details);
  return article;
}

function renderBank(paused) {
  const container = elements["bank-resources"];
  const enabled = isMyTurn() && !paused && currentRoom.phase === "action";
  const stacks = tokenTypes.map((type) => {
    const item = document.createElement("button");
    const icon = makeResourceIcon(type);
    const count = document.createElement("strong");
    const selectedCount = selectedResourcePicks.filter((resource) => resource === type).length;
    const selectable = canSelectResource(type, enabled);

    item.type = "button";
    item.className = `bank-resource bank-resource-${type}`;
    if (selectable) item.classList.add("is-selectable");
    if (selectedCount) item.classList.add("is-selected");
    item.disabled = !selectable;
    item.setAttribute("aria-pressed", String(selectedCount > 0));
    item.setAttribute("aria-label", `${resourceNames[type]}: ${currentRoom.bank[type]}`);
    icon.alt = resourceNames[type];
    count.textContent = currentRoom.bank[type];
    item.append(icon, count);
    item.addEventListener("click", () => selectResource(type, paused));
    return item;
  });

  const selectionRow = document.createElement("div");
  selectionRow.className = "selected-resource-row";
  selectionRow.hidden = selectedResourcePicks.length === 0;
  if (selectedResourcePicks.length) {
    const selection = document.createElement("div");
    selection.className = "selected-resource-list";
    for (const type of tokenTypes) {
      const amount = selectedResourcePicks.filter((resource) => resource === type).length;
      if (!amount) continue;
      const chip = document.createElement("button");
      const icon = makeResourceIcon(type);
      const count = document.createElement("strong");
      chip.type = "button";
      chip.className = "selected-resource-chip";
      chip.title = `Usuń ${resourceNames[type]} z wyboru`;
      chip.setAttribute("aria-label", chip.title);
      icon.alt = resourceNames[type];
      count.textContent = String(amount);
      chip.append(icon, count);
      chip.addEventListener("click", () => removeSelectedResource(type, paused));
      selection.append(chip);
    }
    selectionRow.append(selection);

    if (canTakeSelectedResources()) {
      const takeButton = makeButton("Weź żetony", "game-button game-button-primary take-selected-resources");
      takeButton.addEventListener("click", takeSelectedResources);
      selectionRow.append(takeButton);
    }
  }

  container.replaceChildren(...stacks, selectionRow);
}

function renderActions(paused) {
  const actions = elements["game-actions"];
  actions.replaceChildren();
  if (currentRoom.status !== "playing") return;
  const hint = document.createElement("p");
  hint.textContent = paused
    ? "Wybieranie żetonów jest wstrzymane do powrotu graczy."
    : "Kliknij podświetlone stosy, aby wybrać żetony.";
  actions.append(hint);
}

function canSelectResource(type, enabled) {
  if (!enabled || !resources.includes(type) || currentRoom.bank[type] < 1) return false;
  const selected = selectedResourcePicks;

  if (!selected.length) return true;
  if (selected.length === 1) {
    if (selected[0] === type) return resourceBankSnapshot?.[type] >= 4;
    return true;
  }
  if (selected.length === 2) {
    const hasPair = selected[0] === selected[1];
    return !hasPair && !selected.includes(type);
  }
  return false;
}

function canTakeSelectedResources() {
  if (selectedResourcePicks.length === 2 &&
    selectedResourcePicks[0] === selectedResourcePicks[1]) return true;

  const selectedKinds = new Set(selectedResourcePicks).size;
  const availableKinds = availableResourceTypes().length;
  return selectedKinds > 0 && selectedKinds === Math.min(3, availableKinds);
}

function selectResource(type, paused) {
  const enabled = isMyTurn() && !paused && currentRoom.phase === "action";
  if (!canSelectResource(type, enabled)) return;
  if (!selectedResourcePicks.length) resourceBankSnapshot = { ...currentRoom.bank };
  selectedResourcePicks.push(type);
  renderBank(paused);
}

function removeSelectedResource(type, paused) {
  const index = selectedResourcePicks.lastIndexOf(type);
  if (index < 0) return;
  selectedResourcePicks.splice(index, 1);
  if (!selectedResourcePicks.length) resourceBankSnapshot = null;
  renderBank(paused);
}

function takeSelectedResources() {
  const selection = [...selectedResourcePicks];
  if (selection.length === 2 && selection[0] === selection[1]) {
    performAction((game) => takeTwoResources(game, currentUser.uid, selection[0], heroMap));
    return;
  }
  performAction((game) => takeResources(game, currentUser.uid, selection, heroMap));
}

function availableResourceTypes() {
  return resources.filter((resource) => currentRoom.bank[resource] > 0);
}

function renderHeroes(paused) {
  const container = elements["game-heroes"];
  container.dataset.count = String(currentRoom.availableHeroes.length);
  container.replaceChildren();

  for (const heroId of currentRoom.availableHeroes) {
    const hero = getHero(heroMap, heroId);
    const canSelect = currentRoom.phase === "hero" &&
      currentRoom.pendingResolution?.uid === currentUser.uid &&
      currentRoom.pendingResolution.heroIds.includes(String(heroId)) && isMyTurn() && !paused;
    const tile = createHeroTile(hero, canSelect ? () => performAction((game) => {
      selectHero(game, currentUser.uid, heroId, heroMap);
    }) : null);
    container.append(tile);
  }

  if (!container.children.length) {
    const empty = document.createElement("p");
    empty.className = "market-empty";
    empty.textContent = "W tej partii nie ma już dostępnych bohaterów.";
    container.append(empty);
  }
}

function renderResolution(paused) {
  const panel = elements["game-resolution"];
  const discardDialog = elements["discard-dialog"];
  panel.hidden = true;
  panel.replaceChildren();
  discardDialog.replaceChildren();
  if (currentRoom.status !== "playing" || paused || !currentRoom.pendingResolution) {
    if (discardDialog.open) discardDialog.close();
    discardSelectionKey = "";
    return;
  }

  const pending = currentRoom.pendingResolution;
  const title = document.createElement("h3");
  const dialogHeading = document.createElement("div");
  const content = document.createElement("div");
  panel.className = "game-resolution";

  if (pending.uid !== currentUser.uid) {
    if (discardDialog.open) discardDialog.close();
    title.textContent = `Oczekiwanie na ${currentRoom.players.find((player) => player.uid === pending.uid)?.name || "gracza"}`;
    panel.append(title);
    panel.hidden = false;
    return;
  }

  if (currentRoom.phase === "discard") {
    const selectionKey = `${pending.uid}:${pending.count}`;
    if (selectionKey !== discardSelectionKey) {
      discardSelection = emptyCounts();
      discardSelectionKey = selectionKey;
    }
    title.textContent = `Odrzuć dokładnie ${pending.count} znaczników`;
    title.id = "discard-title";
    dialogHeading.className = "discard-dialog-heading";
    const tokenCounter = document.createElement("strong");
    tokenCounter.className = "discard-token-counter";
    const heldTokens = tokenTypes.reduce(
      (sum, type) => sum + Number(currentGamePlayer().tokens[type] || 0),
      0,
    );
    tokenCounter.textContent = `Żetony: ${heldTokens}/10`;
    dialogHeading.append(title, tokenCounter);
    content.className = "discard-choices";

    for (const type of tokenTypes) {
      const available = currentGamePlayer().tokens[type];
      if (!available) continue;
      const row = document.createElement("div");
      const label = document.createElement("span");
      const controls = document.createElement("div");
      const minus = makeButton("−", "game-button game-button-stepper");
      const amount = document.createElement("strong");
      const plus = makeButton("+", "game-button game-button-stepper");
      const selectedAmount = discardSelection[type];
      row.className = "discard-row";
      label.className = "discard-resource";
      label.append(makeResourceIcon(type), document.createTextNode(`${resourceNames[type]} (${available})`));
      controls.className = "discard-stepper";
      amount.textContent = String(selectedAmount);
      minus.disabled = selectedAmount === 0;
      minus.addEventListener("click", () => updateDiscardSelection(type, -1, amount, minus, plus, available, pending.count));
      plus.addEventListener("click", () => updateDiscardSelection(type, 1, amount, minus, plus, available, pending.count));
      plus.disabled = selectedAmount >= available ||
        tokenTypes.reduce((sum, key) => sum + discardSelection[key], 0) >= pending.count;
      controls.append(minus, amount, plus);
      row.append(label, controls);
      content.append(row);
    }

    const submit = makeButton("Zatwierdź odrzucenie", "game-button game-button-primary");
    submit.disabled = true;
    submit.addEventListener("click", () => performAction((game) => {
      discardTokens(game, currentUser.uid, discardSelection, heroMap);
    }));
    const selectedTotal = tokenTypes.reduce((sum, type) => sum + discardSelection[type], 0);
    submit.disabled = selectedTotal !== pending.count;
    discardDialog.append(dialogHeading, content, submit);
    discardDialog._tokenCounter = tokenCounter;
    discardDialog._submitButton = submit;
    if (!discardDialog.dataset.cancelGuard) {
      discardDialog.addEventListener("cancel", (event) => {
        if (currentRoom?.phase === "discard") event.preventDefault();
      });
      discardDialog.dataset.cancelGuard = "true";
    }
    if (!discardDialog.open) discardDialog.showModal();
    return;
  } else if (currentRoom.phase === "hero") {
    if (discardDialog.open) discardDialog.close();
    title.textContent = "Możesz przyjąć wizytę tylko jednego bohatera";
    const instruction = document.createElement("p");
    instruction.textContent = "Wybierz jedną z podświetlonych płytek powyżej.";
    panel.append(title, instruction);
  }

  panel.hidden = false;
}

function updateDiscardSelection(type, delta, amountElement, minusButton, plusButton, available, required) {
  const current = discardSelection[type];
  const total = tokenTypes.reduce((sum, key) => sum + discardSelection[key], 0);
  const next = current + delta;
  if (next < 0 || next > available || (delta > 0 && total >= required)) return;
  discardSelection[type] = next;
  amountElement.textContent = String(next);
  minusButton.disabled = next === 0;
  plusButton.disabled = next >= available || total + delta >= required;
  const selectedTotal = tokenTypes.reduce((sum, key) => sum + discardSelection[key], 0);
  elements["discard-dialog"]._submitButton.disabled = selectedTotal !== required;
  const heldTotal = tokenTypes.reduce(
    (sum, key) => sum + Number(currentGamePlayer().tokens[key] || 0),
    0,
  );
  elements["discard-dialog"]._tokenCounter.textContent = `Żetony: ${heldTotal - selectedTotal}/10`;

  for (const row of elements["discard-dialog"].querySelectorAll(".discard-row")) {
    const rowType = tokenTypes.find((key) => row.querySelector(".discard-resource")?.textContent.startsWith(resourceNames[key]));
    if (!rowType) continue;
    const rowPlus = row.querySelectorAll("button")[1];
    const rowAmount = discardSelection[rowType];
    rowPlus.disabled = rowAmount >= currentGamePlayer().tokens[rowType] || selectedTotal >= required;
  }
}

function renderFinished() {
  const panel = elements["game-finished"];
  panel.hidden = currentRoom.status !== "finished";
  panel.replaceChildren();
  if (panel.hidden) return;

  const heading = document.createElement("h3");
  const winners = currentRoom.players.filter((player) => currentRoom.winnerUids.includes(player.uid));
  heading.textContent = winners.length > 1
    ? "Gra zakończyła się remisem"
    : `Zwycięża ${winners[0]?.name || "—"}!`;
  const scores = document.createElement("div");
  scores.className = "final-scores";
  for (const player of [...currentRoom.players].sort((left, right) => right.points - left.points)) {
    const line = document.createElement("p");
    line.textContent = `${player.name}: ${player.points} pkt, ${player.boughtCardIds.length} kart`;
    scores.append(line);
  }
  panel.append(heading, scores);
}

function updateConnectionLabel(paused = false) {
  if (!firebaseReady) {
    setConnection("Skonfiguruj Firebase", "error");
  } else if (!navigator.onLine) {
    setConnection("Brak internetu", "error");
  } else if (!firebasePresenceReady && currentRoom) {
    setConnection("Brak monitorowania połączeń", "waiting");
  } else if (currentRoom && currentRoom.status === "playing" && paused) {
    setConnection("Oczekiwanie na graczy", "waiting");
  } else if (currentRoom) {
    setConnection("Połączono", "online");
  } else {
    setConnection("Gotowy do gry", "online");
  }
}

function renderEmptyConfig() {
  if (!firebaseReady) {
    setConnection("Skonfiguruj Firebase", "error");
    showMessage("Aby uruchomić grę online, wklej ustawienia aplikacji Firebase do firebase-config.js. Instrukcja konfiguracji znajduje się w README.md.", "setup");
    elements["sign-in-button"].disabled = true;
    return;
  }
  elements["sign-in-button"].disabled = false;
  setConnection(firebasePresenceReady ? "Połączono z Firebase" : "Firebase gotowy — brak presence", "online");
  if (!firebasePresenceReady) {
    showMessage("Logowanie i partie Firestore są skonfigurowane. Aby automatycznie wykrywać rozłączenia i wstrzymywać grę, dodaj databaseURL Realtime Database do firebase-config.js.", "setup");
  }
}

function leaveRoomView() {
  stopRoomSubscriptions();
  currentRoomId = null;
  currentRoom = null;
  activeScreen = "home";
  ownPrivateState = { reservedCardIds: [] };
  setRoomUrl(null);
  renderGame();
}

async function leaveRoom() {
  if (!currentRoomId || !currentRoom || !currentUser) return;
  const roomId = currentRoomId;
  const gameRef = roomReference(roomId);
  const ownRef = privateReference(roomId, currentUser.uid);

  try {
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(gameRef);
      if (!snapshot.exists()) return;
      const room = snapshot.data();
      if (room.status !== "lobby") throw new Error("Partia już trwa. Możesz wrócić przez ten sam link.");
      const members = room.members.filter((member) => member.uid !== currentUser.uid);
      const memberUids = room.memberUids.filter((uid) => uid !== currentUser.uid);
      const players = room.players.filter((player) => player.uid !== currentUser.uid);

      if (members.length === 0) {
        transaction.delete(gameRef);
        transaction.delete(ownRef);
        return;
      }

      room.members = members;
      room.memberUids = memberUids;
      room.players = players;
      if (room.hostUid === currentUser.uid) room.hostUid = members[0].uid;
      transaction.set(gameRef, room);
      transaction.delete(ownRef);
    });
    leaveRoomView();
    showMessage("");
  } catch (error) {
    console.error(error);
    showMessage(firebaseErrorMessage(error), "error");
  }
}

async function leaveGame() {
  if (!currentRoomId || !currentRoom || !currentUser) return;
  const shouldLeave = window.confirm(
    "Opuszczenie gry zamknie pokój i usunie całą partię dla wszystkich graczy. " +
    "Nie będzie można wrócić do tego zapisu. Czy na pewno chcesz opuścić grę?",
  );
  if (!shouldLeave) return;

  const roomId = currentRoomId;
  const gameRef = roomReference(roomId);

  try {
    const snapshot = await getDoc(gameRef);
    if (!snapshot.exists()) {
      leaveRoomView();
      showMessage("Ta partia została już zamknięta.");
      return;
    }

    const room = snapshot.data();
    if (!room.memberUids.includes(currentUser.uid)) {
      throw new Error("Nie jesteś już uczestnikiem tej partii.");
    }

    const batch = writeBatch(db);
    const leavingPlayer = room.players.find((player) => player.uid === currentUser.uid);
    batch.set(doc(db, "roomClosures", roomId), {
      memberUids: room.memberUids,
      closedByUid: currentUser.uid,
      closedByName: leavingPlayer?.name || currentUser.displayName || "Gracz",
      closedAt: serverTimestamp(),
    });
    for (const uid of room.memberUids) {
      batch.delete(privateReference(roomId, uid));
    }
    batch.delete(gameRef);
    await batch.commit();

    leaveRoomView();
    showMessage("Partia została zamknięta i usunięta dla wszystkich graczy.");
  } catch (error) {
    console.error(error);
    showMessage(firebaseErrorMessage(error), "error");
  }
}

function makeResourceIcon(type) {
  const icon = document.createElement("img");
  icon.className = "resource-icon";
  icon.src = `sprites/resource/${type}.png`;
  icon.alt = "";
  icon.loading = "lazy";
  return icon;
}

function makeButton(text, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  return button;
}

function makeEmptyNote(text) {
  const note = document.createElement("p");
  note.className = "game-empty-note";
  note.textContent = text;
  return note;
}

function firebaseErrorMessage(error) {
  const message = error?.message || "Wystąpił nieoczekiwany błąd.";
  if (error?.code === "permission-denied") return "Firebase zablokował tę operację. Sprawdź reguły Firestore oraz członkostwo w pokoju.";
  if (error?.code === "auth/popup-blocked") return "Przeglądarka zablokowała okno logowania Google.";
  return message;
}

async function signIn() {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (error) {
    console.error(error);
    showMessage(firebaseErrorMessage(error), "error");
  }
}

async function signOutUser() {
  try {
    if (currentRoomId && realtimeDb) {
      await set(ref(realtimeDb, `presence/${currentRoomId}/${currentUser.uid}`), {
        state: "offline",
        changedAt: serverTimestamp(),
      });
    }
    stopRoomSubscriptions();
    currentRoomId = null;
    currentRoom = null;
    activeScreen = "home";
    setRoomUrl(null);
    await signOut(auth);
  } catch (error) {
    console.error(error);
    showMessage(firebaseErrorMessage(error), "error");
  }
}

async function copyInvite() {
  try {
    await navigator.clipboard.writeText(elements["invite-link"].value);
    elements["copy-invite-button"].textContent = "Skopiowano";
  } catch {
    elements["invite-link"].select();
    document.execCommand("copy");
    elements["copy-invite-button"].textContent = "Skopiowano";
  }
  window.setTimeout(() => {
    elements["copy-invite-button"].textContent = "Kopiuj link";
  }, 1800);
}

async function bootstrap() {
  elements["sign-in-button"].addEventListener("click", signIn);
  elements["sign-out-button"].addEventListener("click", signOutUser);
  elements["create-room-button"].addEventListener("click", createRoom);
  elements["start-game-button"].addEventListener("click", startGame);
  elements["copy-invite-button"].addEventListener("click", copyInvite);
  elements["leave-room-button"].addEventListener("click", leaveRoom);
  elements["leave-game-button"].addEventListener("click", leaveGame);
  elements["game-back-button"].addEventListener("click", () => {
    activeScreen = "home";
    renderGame();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  elements["return-to-game-button"].addEventListener("click", () => {
    activeScreen = "game";
    renderGame();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  window.addEventListener("online", () => updateConnectionLabel());
  window.addEventListener("offline", () => {
    if (currentUser) presenceByUid.set(currentUser.uid, "offline");
    setConnection("Brak internetu", "error");
    renderGame();
  });

  await initializeGameData();
  renderEmptyConfig();
  if (!firebaseReady) return;

  onAuthStateChanged(auth, async (user) => {
    setSignedIn(user);
    renderGame();
    if (!user) {
      stopRoomSubscriptions();
      currentRoomId = null;
      currentRoom = null;
      updateConnectionLabel();
      return;
    }

    const roomFromLink = new URL(window.location.href).searchParams.get("room");
    if (roomFromLink && !inviteAttempted) {
      inviteAttempted = true;
      await joinRoom(roomFromLink);
    } else if (currentRoomId) {
      watchRoom(currentRoomId);
    }
    updateConnectionLabel();
  });
}

bootstrap();
