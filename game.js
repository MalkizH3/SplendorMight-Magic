import {
  auth,
  authInitialization,
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
  localTestMode,
  signInAnonymously,
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
} from "./game-engine.js?v=public-reservations-2";
import { createCardArtwork } from "./card-view.js";
import { createHeroTile } from "./hero-view.js";

const elements = Object.fromEntries([
  "game-connection", "game-message", "game-section", "game-back-button",
  "auth-panel", "auth-description", "local-test-note", "sign-in-button",
  "anonymous-sign-in-button", "sign-out-button",
  "game-profile", "profile-name", "lobby-panel", "lobby-home", "lobby-resume",
  "return-to-game-button", "leave-game-button", "create-room-button",
  "room-lobby", "lobby-player-count", "lobby-player-list", "invite-link",
  "copy-invite-button", "leave-room-button", "start-game-button", "lobby-hint",
  "game-board", "turn-label", "turn-status", "round-status", "game-players",
  "market-tiers", "bank-resources", "game-actions", "game-heroes",
  "game-resolution", "discard-dialog", "room-closure-dialog",
  "room-closure-message", "room-closure-dismiss", "game-finished",
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
  let roomClosureHandled = false;

  const handleRoomClosure = (closure) => {
    if (roomClosureHandled) return;
    roomClosureHandled = true;
    stopRoomSubscriptions();
    currentRoom = null;
    leaveRoomView();

    if (closure?.closedByUid && closure.closedByUid !== currentUser?.uid) {
      const closureMessage =
        `Zakończono: gracz ${closure.closedByName || "Gracz"} opuścił grę.`;
      elements["room-closure-message"].textContent = closureMessage;
      showMessage(closureMessage);
      elements["room-closure-dialog"].showModal();
    } else if (closure?.closedByUid === currentUser?.uid) {
      showMessage("Partia została zamknięta i usunięta dla wszystkich graczy.");
    } else {
      showMessage("Partia została zamknięta.");
    }
  };

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
      handleRoomClosure(closure);
      return;
    }

    currentRoom = { id: snapshot.id, ...snapshot.data() };
    syncPresenceWatchers();
    renderGame();
    publishLegacyReservations(roomId).catch(console.error);
  }, async (error) => {
    console.error(error);

    // Firestore rules may report permission-denied instead of an empty snapshot
    // after another member atomically deletes the room and writes its closure.
    let closure = null;
    try {
      const closureSnapshot = await getDoc(doc(db, "roomClosures", roomId));
      if (closureSnapshot.exists()) closure = closureSnapshot.data();
    } catch (closureError) {
      console.error(closureError);
    }
    if (currentRoomId !== roomId) return;
    if (closure?.closedByUid) {
      handleRoomClosure(closure);
      return;
    }

    showMessage("Nie udało się połączyć z pokojem. Odśwież stronę i spróbuj ponownie.", "error");
  });

  stopPrivateListener = onSnapshot(privateReference(roomId), (snapshot) => {
    ownPrivateState = snapshot.exists()
      ? snapshot.data()
      : { reservedCardIds: [] };
    renderGame();
    publishLegacyReservations(roomId, true).catch(console.error);
  }, async (error) => {
    console.error(error);

    let closure = null;
    try {
      const closureSnapshot = await getDoc(doc(db, "roomClosures", roomId));
      if (closureSnapshot.exists()) closure = closureSnapshot.data();
    } catch (closureError) {
      console.error(closureError);
    }
    if (currentRoomId !== roomId || roomClosureHandled) return;
    if (closure?.closedByUid) {
      handleRoomClosure(closure);
      return;
    }

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
  elements["profile-name"].textContent = getPlayerName(user);
}

function getPlayerName(user) {
  if (!user) return "Gracz";
  if (user.displayName) return user.displayName;
  if (user.isAnonymous) return `Tester-${user.uid.slice(-4)}`;
  return user.email || "Gracz";
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
          name: getPlayerName(currentUser),
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
          reservedCardIds: [],
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

// Repair missing or stale public reservations using the owner's saved cards.
async function publishLegacyReservations(roomId, verifySavedCards = false) {
  const uid = currentUser?.uid;
  const player = currentRoom?.players.find((entry) => entry.uid === uid);
  if (!uid || !player) return;
  if (!verifySavedCards && Array.isArray(player.reservedCardIds) &&
      player.reservedCardIds.length === player.reservedCount) return;
  const gameRef = roomReference(roomId);
  const ownRef = privateReference(roomId, uid);
  await runTransaction(db, async (transaction) => {
    const [roomSnapshot, privateSnapshot] = await Promise.all([
      transaction.get(gameRef), transaction.get(ownRef),
    ]);
    if (!roomSnapshot.exists()) return;
    const game = roomSnapshot.data();
    const owner = game.players.find((entry) => entry.uid === uid);
    if (!owner || !privateSnapshot.exists()) return;
    const savedIds = privateSnapshot.data().reservedCardIds || [];
    if (JSON.stringify(owner.reservedCardIds) === JSON.stringify(savedIds) &&
        owner.reservedCount === savedIds.length) return;
    owner.reservedCardIds = [...savedIds];
    owner.reservedCount = savedIds.length;
    transaction.set(gameRef, game);
  });
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
    const owner = game.players.find((entry) => entry.uid === currentUser.uid);
    if (owner) {
      owner.reservedCardIds = [...privateState.reservedCardIds];
      owner.reservedCount = owner.reservedCardIds.length;
    }
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

// Keep source geometry briefly: public and private reservation snapshots can arrive separately.
const cardFlightSources = new Map();
let cardFlightRoomId = null;
let cardFlightPlayers = null;

function captureCardFlights() {
  if (cardFlightRoomId !== currentRoomId) {
    cardFlightSources.clear();
    cardFlightPlayers = null;
    cardFlightRoomId = currentRoomId;
  }
  const now = performance.now();
  for (const [key, source] of cardFlightSources) {
    if (now - source.time > 5000) cardFlightSources.delete(key);
  }
  document.querySelectorAll("[data-flight-card]").forEach((node) => {
    const visual = node.matches(".hero-tile")
      ? node : node.querySelector(".market-card-art, .player-card-display");
    if (!visual) return;
    const rect = node.classList.contains("market-card")
      ? visual.getBoundingClientRect() : node.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const owner = node.closest("[data-player-uid]")?.dataset.playerUid || "market";
    cardFlightSources.set(`${owner}:${node.dataset.flightCard}`, {
      rect, visual: visual.cloneNode(true), time: now,
    });
  });
  const previous = cardFlightPlayers;
  cardFlightPlayers = new Set(Array.from(
    elements["game-players"].querySelectorAll("[data-flight-card]"),
    (node) => `${node.closest("[data-player-uid]").dataset.playerUid}:${node.dataset.flightZone}:${node.dataset.flightCard}`,
  ));
  return previous !== null ? cardFlightPlayers : null;
}

function animateCardFlights(previous) {
  if (!previous || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  elements["game-players"].querySelectorAll("[data-flight-card]").forEach((target) => {
    const uid = target.closest("[data-player-uid]").dataset.playerUid;
    const id = target.dataset.flightCard;
    if (previous.has(`${uid}:${target.dataset.flightZone}:${id}`)) return;
    const source = cardFlightSources.get(`${uid}:${id}`) || cardFlightSources.get(`market:${id}`);
    if (!source) return;
    const end = target.getBoundingClientRect();
    if (!end.width || !end.height) return;
    const start = source.rect;
    const flight = document.createElement("div");
    flight.className = "card-flight";
    flight.setAttribute("aria-hidden", "true");
    Object.assign(flight.style, {
      left: `${start.left}px`, top: `${start.top}px`,
      width: `${start.width}px`, height: `${start.height}px`,
    });
    const front = document.createElement("div");
    front.className = "card-flight-front";
    front.append(source.visual.cloneNode(true));
    const final = document.createElement("div");
    final.className = "card-flight-final";
    final.append(target.querySelector(".player-card-display").cloneNode(true));
    flight.append(front, final);
    document.body.append(flight);
    // Opacity animation hides the real badge without losing layout or hover state.
    const hidden = target.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 740, fill: "both" });
    const dx = end.left - start.left;
    const dy = end.top - start.top;
    const motion = flight.animate([
      { transform: "translate(0, 0) rotate(0deg)", width: `${start.width}px`, height: `${start.height}px`, borderRadius: "7px" },
      { transform: `translate(${dx * .48}px, ${dy * .48 - 45}px) rotate(-6deg)`, width: `${start.width * .78 + end.width * .22}px`, height: `${start.height * .78 + end.height * .22}px`, borderRadius: "10px", offset: .45 },
      { transform: `translate(${dx}px, ${dy}px) rotate(0deg)`, width: `${end.width}px`, height: `${end.height}px`, borderRadius: "4px" },
    ], { duration: 740, easing: "cubic-bezier(.22,.65,.25,1)", fill: "forwards" });
    front.animate([{ opacity: 1 }, { opacity: 1, offset: .3 }, { opacity: 0, offset: .85 }, { opacity: 0 }], { duration: 740, fill: "forwards" });
    final.animate([{ opacity: 0 }, { opacity: 0, offset: .35 }, { opacity: 1, offset: .9 }, { opacity: 1 }], { duration: 740, fill: "forwards" });
    const cleanup = () => { flight.remove(); hidden.cancel(); };
    motion.finished.then(cleanup, cleanup);
  });
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

  const previousCards = captureCardFlights();
  renderPlayers();
  renderMarket(paused);
  renderBank(paused);
  renderActions(paused);
  renderHeroes(paused);
  renderResolution(paused);
  renderFinished();
  updateConnectionLabel(paused);
  animateCardFlights(previousCards);
}

function renderPlayers() {
  elements["game-players"].replaceChildren(...currentRoom.players.map((player) => {
    const card = document.createElement("article");
    const heading = document.createElement("div");
    const name = document.createElement("strong");
    const score = document.createElement("span");
    const resourceList = document.createElement("div");

    card.className = "game-player-card";
    card.dataset.playerUid = player.uid;
    if (player.uid === currentRoom.currentTurnUid && currentRoom.status === "playing") {
      card.classList.add("is-active");
    }
    name.textContent = player.uid === currentUser.uid ? `${player.name} (Ty)` : player.name;
    score.className = "player-score";
    score.textContent = `${player.points}/15 pkt`;
    heading.className = "game-player-heading";
    heading.append(name, score);
    if (currentRoom.status === "finished" && currentRoom.winnerUids.includes(player.uid)) {
      card.classList.add("is-winner");
      const winnerBadge = document.createElement("div");
      winnerBadge.className = "player-winner-badge";
      winnerBadge.setAttribute("role", "status");
      winnerBadge.textContent = currentRoom.winnerUids.length > 1
        ? "♛ Współzwycięzca" : "♛ Zwycięzca";
      const identity = document.createElement("div");
      identity.className = "player-winner-identity";
      identity.append(winnerBadge, name);
      heading.prepend(identity);
    }
    resourceList.className = "player-bonuses";

    for (const resource of resources) {
      const bonusCount = Number(player.bonuses[resource] || 0);
      if (bonusCount === 0) continue;

      const bonus = document.createElement("span");
      bonus.className = "bonus-count";
      const icon = makeResourceIcon(resource);
      const number = document.createElement("b");
      icon.alt = "";
      number.textContent = bonusCount;
      bonus.append(icon, number);
      resourceList.append(bonus);
    }
    resourceList.prepend(createPlayerSectionHeading("Bonusy"));

    const tokens = document.createElement("div");
    tokens.className = "player-tokens";
    for (const type of tokenTypes) {
      const tokenCount = Number(player.tokens[type] || 0);
      if (tokenCount === 0) continue;

      const token = document.createElement("span");
      const count = document.createElement("b");
      token.className = "player-token";
      token.title = resourceNames[type];
      count.textContent = String(tokenCount);
      token.append(makeResourceIcon(type), count);
      tokens.append(token);
    }
    const tokenTotal = tokenTypes.reduce(
      (total, type) => total + Number(player.tokens[type] || 0),
      0,
    );
    tokens.prepend(createPlayerSectionHeading("Żetony", `(${tokenTotal}/10)`));

    const ownedCards = document.createElement("div");
    ownedCards.className = "player-visible-cards";
    for (const cardId of player.boughtCardIds) {
      const ownedCard = getCard(cardMap, cardId);
      ownedCards.append(makePlayerCardBadge(ownedCard));
    }
    ownedCards.prepend(createPlayerSectionHeading("Kupione karty"));

    const reservations = document.createElement("section");
    const reservationHeading = document.createElement("div");
    const reservationLabel = document.createElement("span");
    const reservationCount = document.createElement("strong");
    const reservationCards = document.createElement("div");
    reservations.className = "player-reservations";
    reservationHeading.className = "player-section-heading player-reservations-heading";
    reservationLabel.textContent = "Zarezerwowane";
    reservationCount.textContent = `(${player.reservedCount}/3)`;
    reservationCards.className = "player-visible-reservations";
    reservationHeading.append(reservationLabel, reservationCount);

    const publicIds = player.reservedCardIds;
    const privateIds = ownPrivateState.reservedCardIds;
    const reservedCardIds = player.uid === currentUser.uid &&
      privateIds.length === player.reservedCount && publicIds?.length !== player.reservedCount
      ? privateIds : (publicIds ?? (player.uid === currentUser.uid ? privateIds : []));
    for (const cardId of reservedCardIds) {
      reservationCards.append(makePlayerCardBadge(
        getCard(cardMap, cardId), true, player.uid === currentUser.uid,
      ));
    }
    reservations.append(reservationHeading, reservationCards);

    const ownedHeroes = document.createElement("div");
    ownedHeroes.className = "player-visible-heroes";
    for (const heroId of player.heroIds) {
      const hero = getHero(heroMap, heroId);
      const badge = document.createElement("div");
      const display = document.createElement("div");
      const points = document.createElement("strong");
      const avatar = document.createElement("img");
      badge.className = "player-visible-card player-hero-badge";
      badge.dataset.flightCard = `hero:${hero.id}`;
      badge.dataset.flightZone = "hero";
      badge.tabIndex = 0;
      badge.setAttribute("aria-label", `${hero.name}: ${hero.victoryPoints} punktów zwycięstwa`);
      display.className = "player-card-display";
      points.className = "player-card-points";
      points.textContent = String(hero.victoryPoints);
      avatar.className = "player-hero-avatar";
      avatar.src = hero.background;
      avatar.alt = hero.name;
      display.append(points, avatar);
      const hoverHero = document.createElement("div");
      hoverHero.className = "player-card-hover-card";
      const preview = createHeroTile(hero);
      preview.classList.add("player-hero-hover-preview");
      hoverHero.append(preview);
      badge.append(display, hoverHero);
      ownedHeroes.append(badge);
    }
    if (ownedHeroes.childElementCount > 0) {
      ownedHeroes.prepend(createPlayerSectionHeading("Bohaterowie"));
    }
    ownedHeroes.hidden = player.heroIds.length === 0;
    card.append(heading, tokens, resourceList, ownedCards, reservations, ownedHeroes);
    return card;
  }));
}

function createPlayerSectionHeading(label, count = "") {
  const heading = document.createElement("div");
  const text = document.createElement("span");

  heading.className = "player-section-heading";
  text.textContent = label;
  heading.append(text);
  if (count) {
    const value = document.createElement("strong");
    value.textContent = count;
    heading.append(value);
  }
  return heading;
}

function makePlayerCardBadge(card, isReserved = false, ownedByMe = false) {
  const badge = document.createElement("div");
  const display = document.createElement("div");
  const hoverCard = document.createElement("div");
  const points = document.createElement("strong");
  const bonusIcon = makeResourceIcon(card.bonusResource);

  badge.className = "player-visible-card";
  badge.dataset.flightCard = card.id;
  badge.dataset.flightZone = isReserved ? "reserved" : "bought";
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

  if (isReserved && ownedByMe && isMyTurn() && currentRoom.phase === "action") {
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
  article.dataset.flightCard = card.id;
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
    tile.dataset.flightCard = `hero:${hero.id}`;
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
    const tokenWord = pending.count === 1
      ? "znacznik"
      : pending.count >= 2 && pending.count <= 4
        ? "znaczniki"
        : "znaczników";
    title.textContent = `Odrzuć dokładnie ${pending.count} ${tokenWord}`;
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

const celebratedGames = new Set();

function renderFinished() {
  const panel = elements["game-finished"];
  panel.hidden = true;
  panel.replaceChildren();
  if (currentRoom.status !== "finished" || elements["game-board"].hidden) return;
  const gameKey = `${currentRoomId}:${currentRoom.startedAt}`;
  if (celebratedGames.has(gameKey)) return;
  celebratedGames.add(gameKey);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const confetti = document.createElement("div");
  confetti.className = "victory-confetti";
  confetti.setAttribute("aria-hidden", "true");
  const colors = ["#e9c46a", "#f4a261", "#e76f51", "#63c9b4", "#82adff", "#e8a8e0"];
  const animations = [];
  for (let index = 0; index < 100; index += 1) {
    const piece = document.createElement("i");
    piece.className = "victory-confetti-piece";
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.backgroundColor = colors[index % colors.length];
    piece.style.width = `${5 + Math.random() * 6}px`;
    piece.style.height = `${8 + Math.random() * 8}px`;
    piece.style.borderRadius = index % 3 === 0 ? "50%" : "1px";
    confetti.append(piece);
    const drift = (Math.random() - .5) * 280;
    const rotation = (Math.random() - .5) * 1440;
    animations.push(piece.animate([
      { transform: "translate3d(0, -30px, 0) rotate(0deg)", opacity: 0 },
      { opacity: 1, offset: .08 },
      { transform: `translate3d(${drift * .4}px, 45vh, 0) rotate(${rotation * .45}deg)`, opacity: 1, offset: .5 },
      { transform: `translate3d(${drift}px, 105vh, 0) rotate(${rotation}deg)`, opacity: 0 },
    ], {
      duration: 3000 + Math.random() * 1800,
      delay: Math.random() * 1600,
      easing: "linear",
      fill: "both",
    }).finished);
  }
  document.body.append(confetti);
  Promise.allSettled(animations).then(() => confetti.remove());
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
      closedByName: leavingPlayer?.name || getPlayerName(currentUser),
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

async function signInAnonymouslyForLocalTest() {
  if (!localTestMode) return;
  try {
    await signInAnonymously(auth);
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
  elements["anonymous-sign-in-button"].hidden = !localTestMode;
  elements["local-test-note"].hidden = !localTestMode;
  if (localTestMode) {
    elements["auth-description"].textContent = "Utwórz tymczasowe konto w emulatorze i testuj partię w osobnej karcie.";
  }
  elements["anonymous-sign-in-button"].addEventListener("click", signInAnonymouslyForLocalTest);
  elements["sign-out-button"].addEventListener("click", signOutUser);
  elements["create-room-button"].addEventListener("click", createRoom);
  elements["start-game-button"].addEventListener("click", startGame);
  elements["copy-invite-button"].addEventListener("click", copyInvite);
  elements["leave-room-button"].addEventListener("click", leaveRoom);
  elements["leave-game-button"].addEventListener("click", leaveGame);
  elements["room-closure-dismiss"].addEventListener("click", () => {
    elements["room-closure-dialog"].close();
  });
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
  await authInitialization;

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
