# Splendor Might & Magic

Statyczna aplikacja na GitHub Pages łączy katalog kart z internetową wersją gry dla 2–4 osób. Dane kart i bohaterów pozostają w `cards.json` i `heroes.json`.

## Konfiguracja Firebase

Gra online wymaga własnego projektu Firebase. W projekcie Firebase:

1. Włącz logowanie Google w **Authentication → Sign-in method**.
2. Dodaj domenę publikacji GitHub Pages do **Authentication → Settings → Authorized domains**.
3. Utwórz bazę **Cloud Firestore** w trybie produkcyjnym.
4. Utwórz **Realtime Database**. Baza służy wyłącznie do wykrywania obecności graczy i pauzowania partii po rozłączeniu.
5. Skopiuj konfigurację aplikacji Web Firebase do `firebase-config.js`. `databaseURL` skopiuj z ustawień Realtime Database. Konfiguracja webowa jest publiczna; nie wklejaj tu klucza konta serwisowego ani prywatnego klucza. Do lokalnego podglądu dodaj również `localhost` oraz `127.0.0.1` do autoryzowanych domen.
6. Zainstaluj Firebase CLI, zaloguj się i ustaw projekt jako domyślny dla katalogu. Wdroż reguły poleceniem `firebase deploy --only firestore:rules,database`.
7. Opublikuj katalog główny repozytorium w GitHub Pages.

Cloud Functions nie są używane. Nie trzeba dodawać projektu ani danych logowania do kodu klienta poza publiczną konfiguracją Web SDK.

## Lokalne uruchamianie

Uruchom katalog przez lokalny serwer HTTP, a następnie otwórz go w przeglądarce. Nie otwieraj pliku `index.html` jako `file://`, ponieważ przeglądarka zablokuje pobieranie plików JSON i modułów.

Opcjonalnie można użyć Firebase Local Emulator Suite. W `firebase-config.js` ustaw `useFirebaseEmulators` na `true`, a następnie uruchom emulatory Authentication, Realtime Database i Firestore. Adres projektu nadal musi być ustawiony w konfiguracji. Logowanie do emulatora nie wykonuje produkcyjnego przepływu OAuth Google.

## Zasady i ograniczenia

- Partie mają 2–4 graczy i dołączają przez prywatny link.
- Firestore przechowuje wspólny stan partii, a Realtime Database informację, czy gracze są połączeni.
- Firestore Rules ograniczają odczyt partii do jej uczestników, a prywatne rezerwacje kart do ich właściciela.
- Bez Cloud Functions uczestnicy muszą sobie ufać: zmodyfikowany klient może zapisać nielegalny ruch lub odczytać kolejność zakrytych kart. Nie należy traktować tych partii jako odpornego na oszustwa trybu rywalizacji.
- Publikacja Cloud Functions wymaga projektu z rozliczeniami w planie Blaze. W tej wersji płatnego backendu celowo nie ma.

## Edycja kart

Dodaj lub zmień karty w `cards.json`, a kafelki bohaterów w `heroes.json`. Ścieżki `background` wskazują pliki graficzne w katalogu `sprites/`.
