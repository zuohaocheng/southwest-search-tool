import minimist from 'minimist';
const argv = minimist(process.argv.slice(2));

if (argv.h) {
    console.log(
        `USAGE: --origin SFO,SJC --destination BUR,LAX --date 2023-03-22 --allow-stop
--origin        Comma separated Airport codes, e.g. SFO,SJC
--destination   Comma separated Airport codes, e.g. BUR,LAX
--date          Comma separated dates, e.g. 2023-03-22,2023-03-24
--allow-stop    Allow flights with stops. Will show anyways if there is no non-stop
`);
    process.exit(0);
}

const debug = !!argv.debug;
const headless = !argv.headful;
const allowStop = !!argv['allow-stop'];

const origins = argv.origin.split(',').map((s: String) => s.toUpperCase().trim());
const destinations = argv.destination.split(',').map((s: String) => s.toUpperCase().trim());
const dates = argv.date.split(',').map(d => new Date(d));

console.log("Origins:", origins)
console.log("Destinations:", destinations)
console.log("Dates:", dates);

import puppeteerVanilla from 'puppeteer';
import { addExtra } from 'puppeteer-extra';

// Patch provided puppeteer and add plugins
const puppeteer = addExtra(puppeteerVanilla)
import repl from "puppeteer-extra-plugin-repl";
// @ts-ignore
puppeteer.use(repl());

(async () => {
    const browser = await puppeteer.launch({
        headless
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36');

    // Start an interactive REPL here
    async function repl() {
        // @ts-ignore
        await page.repl();
        // @ts-ignore
        await browser.repl();
    }

    function delay(max: number, min: number = 0) {
        return { delay: Math.random() * (max - min) + min };
    }

    async function screenshot() {
        if (debug) {
            await page.screenshot({path: `log/${Date.now()}.png`});
        }
    }

    async function retry<T>(lambda: () => Promise<T>): Promise<T> {
        const maxAttempt = debug ? 1 : 3;
        let attempts = 0;
        while (true) {
            try {
                return await lambda();
            } catch (e) {
                console.error(e);
                await screenshot();

                attempts++;
                if (attempts >= maxAttempt) {
                    throw e;
                }
            }
        }
    }

    async function typeInAirportCode(airportCode: string, id: string) {
        await retry(async () => {
            await page.focus(`#${id}`);
            await page.keyboard.press('Backspace');
            await page.keyboard.press('Backspace');
            await page.keyboard.press('Backspace');
            await page.keyboard.press('Backspace');
            await page.keyboard.press('Backspace');
            await page.keyboard.press('Backspace');

            await page.type(`#${id}`, airportCode, delay(50, 10));
            // Click first item in popup
            const selector = `[id^="${id}--item-"]`;
            await page.waitForSelector(selector, {timeout: 1000});
            const matchingEntry = await page.$$eval(selector, (els, airportCode) => els.filter(el => el.textContent?.endsWith(airportCode)).map(el => el.id), airportCode);
            if (matchingEntry.length != 1) {
                throw `Non unique matching airport: ${matchingEntry}.`
            }
            await page.click(`#${matchingEntry[0]}`);

            // @ts-ignore
            const inputValue = await page.$eval(`#${id}`, el => el.value);
            if (inputValue != airportCode) {
                throw `Input mismatch, expected ${airportCode}, actual ${inputValue}.`
            }
        });
    }


    async function search(origin: string, dest: string, date: Date) {
        await page.goto('https://www.southwest.com/air/booking/');

        // Set screen size
        await page.setViewport({ width: 1080, height: 1024 });

        await page.waitForSelector('input[value="oneway"]');
        await page.click('input[value="oneway"]');
        await typeInAirportCode(origin, 'originationAirportCode');
        await page.type('#departureDate', `${date.getUTCMonth() + 1}/${date.getUTCDate()}`);
        await typeInAirportCode(dest, 'destinationAirportCode');

        await submit();
        await stripResult();
    }

    let throttles = 0;

    async function submit() {
        while (true) {
            await page.click('#form-mixin--submit-button', delay(1000 * Math.min(30, Math.exp(throttles))));

            const next = await Promise.race(
                [page.waitForSelector('.price-matrix--airport-codes'),
                page.waitForSelector('.page-error .message_error')]
            );

            if (next == null || await next.evaluate(el => el.textContent?.includes('error'))) {
                await screenshot();
                ++throttles;
                console.warn('Get throttles. Backing off..')
            } else {
                break;
            }
        }
    }

    async function stripResult() {
        const originDest = await page.$eval('.price-matrix--airport-codes', el => el.textContent);
        const date = await page.$eval('.calendar-strip--content_selected', el => el.textContent);
        console.log(`${originDest}, ${date}`);

        if (!allowStop) {
            if (await page.$('.filters--filter-area-nonstop') != null) {
                await page.click('.filters--filter-area-nonstop');
            } else {
                console.info('No non-stop. Showing everything.');
            }
        }

        const results = await page.$$('.air-booking-select-detail');

        for (const result of results) {
            const flightNumber = await result.$eval('.air-operations-flight-numbers .actionable--text', el => el.textContent);
            const depArrTime = await result.$$eval('.air-operations-time-status', els => els.map(el => el.textContent));
            const stops = await result.$eval('.select-detail--number-of-stops', el => el.textContent);

            let price;
            try {
                price = await result.$eval('[data-test="fare-button--wanna-get-away"] .swa-g-screen-reader-only', el => el.textContent);
            } catch (e) {
                price = 'Wanna get away unavailable';
            }

            console.log(`Flight ${flightNumber}, ${stops}, ${depArrTime} @ ${price}`);
        }
    }

    try {
        for (const date of dates) {
            for (const origin of origins) {
                for (const destination of destinations) {
                    await retry(async () => {
                        await search(origin, destination, date);
                    });
                }
            }
        }
    } catch (e) {
        if (debug) {
            console.error(e);
            await repl();
        } else {
            throw e;
        }
    } finally {
        await browser.close();
    }
})();
