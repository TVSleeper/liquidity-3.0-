# UP/BNB V3 Exit App

Локальное приложение для PancakeSwap V3 pool `UP/BNB`.

Функция приложения:
- подключить MetaMask;
- указать Pancake V3 LP NFT `tokenId`;
- выбрать процент изъятия;
- снять ликвидность;
- продать полученные `UP` за `BNB` через этот же V3 pool;
- вернуть NFT обратно на кошелек.

## Адреса

- UP token: `0x000008d2175f9aeaddb2430c26f8a6f73c5a0000`
- UP/BNB V3 pool: `0x57cF8c65Fd1e2B44Ea9E8F8eA0784ac6d0b60624`
- Pancake V3 Position Manager: `0x46A15B0b27311cedF172AB29E4f4766fbE7F4364`
- Pancake V3 Swap Router: `0x13f4EA83D0bd40E75C8222255bc855a974568Dd4`
- WBNB: `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c`

## Запуск

```bash
cd up-bnb-v3-exit-app
npm install
npm run compile:contracts
npm run dev
```

Открой локальный адрес, который покажет терминал.

## Использование

1. Подключить MetaMask в BNB Chain.
2. Нажать `Deploy helper`.
3. Вставить V3 NFT `tokenId`.
4. Нажать `Загрузить NFT`.
5. Указать `Exit %`.
6. При необходимости указать `Min BNB out`.
7. Нажать `Approve V3 NFT`.
8. Нажать `Снять и продать UP за BNB`.
