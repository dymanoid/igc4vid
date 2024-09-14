import * as fsp from 'fs/promises';
import * as fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import yargs from 'yargs';
import * as yh from 'yargs/helpers';
import * as xcs from 'igc-xc-score';
import IGCParser from 'igc-parser';

interface ElevationDataRowLocation {
    readonly lat: number;
    readonly lng: number;
}

interface ElevationDataRow {
    readonly dataset: string;
    readonly elevation: number;
    readonly location: ElevationDataRowLocation;
}

interface ElevationData {
    readonly results: ElevationDataRow[];
    readonly status: string;
}

interface TargetData {
    readonly time: string;
    readonly gpsAlt: number;
    readonly groundElev: number;
    readonly xc: string;
    readonly avgSpeed: number;
}

async function readIgcFile(filePath: string): Promise<IGCParser.IGCFile> {
    const igcString = await fsp.readFile(filePath, { encoding: 'utf8' });
    const result = IGCParser.parse(igcString, { lenient: true });
    return result;
}

async function getGroundElevations(server: string, igc: IGCParser.IGCFile): Promise<number[]> {
    const CHUNK_SIZE = 100;
    let result: number[] = [];
    const dataLength = igc.fixes.length;

    for (let i = 0; i < dataLength; i += CHUNK_SIZE) {
        const chunk = igc.fixes.slice(i, i + CHUNK_SIZE);
        const locations = chunk.map(t => `${t.latitude.toFixed(5)}, ${t.longitude.toFixed(5)}`).join('|');

        const response = await fetch(`${server}?locations=${locations}`);
        process.stdout.write(`Processed ${i}/${dataLength}\r`);

        if (response.ok) {
            const data = (await response.json()) as ElevationData;
            if (data.status.startsWith('OK')) {
                result = result.concat(data.results.map(r => r.elevation));
            }
        } else {
            throw new Error(`Server replies ${response.status}: ${response.text}`);
        }
    }

    return result;
}

function getRouteType(scoringCode: string): string | undefined {
    switch (scoringCode) {
        case 'fai':
            return 'FAI';
        case 'tri':
            return 'flat';
        default:
            return undefined;
    }
}

async function processData(elevationServer: string, igc: IGCParser.IGCFile): Promise<TargetData[]> {
    const CHUNK_SIZE = 60;

    console.log('Getting elevation data...');
    const elevations = await getGroundElevations(elevationServer, igc);
    console.log(`Elevation data size: ${elevations.length}`);
    const processedData: TargetData[] = [];
    console.log('Calculating target dataset...');

    const fixes = igc.fixes;
    if (fixes.length == 0) {
        return [];
    }

    const firstTimestamp = fixes[0].timestamp;

    igc.fixes = [];

    for (let i = 0; i < fixes.length; i += CHUNK_SIZE) {
        process.stdout.write(`Processed ${i}/${fixes.length}\r`);
        const chunk = fixes.slice(i, i + CHUNK_SIZE);
        igc.fixes = igc.fixes.concat(chunk);

        const solver = xcs.solver(igc, xcs.scoringRules.XContest, { noflight: true });
        let solved = false;
        let xc: string = '';
        let avgSpeed: number;
        do {
            const next = solver.next().value;
            solved = next.optimal || false;
            if (solved) {
                const scoreInfo = next.scoreInfo!;
                xc = [
                    getRouteType(next.opt.scoring.code),
                    (scoreInfo.distance - (!scoreInfo.penalty || Number.isNaN(scoreInfo.penalty) ? 0 : scoreInfo.penalty)).toFixed(0),
                    'km',
                ]
                    .filter(Boolean)
                    .join(' ');
                avgSpeed = scoreInfo.distance / ((chunk[chunk.length - 1].timestamp - firstTimestamp) / 3_600_000);
            }
        } while (!solved);

        chunk.forEach((fix, j) => {
            processedData.push({
                time: fix.time,
                gpsAlt: fix.gpsAltitude as number,
                groundElev: elevations[i + j],
                xc,
                avgSpeed,
            });
        });
    }

    return processedData;
}

async function writeProcessedFile(filePath: string, flightDate: string, processedData: TargetData[]) {
    const file = await fsp.open(filePath, 'w');
    try {
        await file.write('date,altitude(m),ground alt(m),agl(m),xc(km),avg speed(km/h)\n');
        for (const { time, groundElev, gpsAlt, xc, avgSpeed } of processedData) {
            await file.write(
                `${flightDate}T${time}Z,${gpsAlt},${groundElev.toFixed(0)},${(gpsAlt - groundElev).toFixed(
                    0
                )},${xc},${avgSpeed.toFixed(1)}\n`
            );
        }
    } finally {
        await file.close();
    }
}

async function run(argv: yargs.ArgumentsCamelCase<{}>) {
    const ELEVATION_SERVER_URL = 'http://localhost:19993/v1/eudem25m';
    const inputPath = argv.filePath as string;

    if (!inputPath) {
        return;
    }

    const sourceIgc = await fsp.realpath(inputPath);
    console.log(`Using this IGC file: ${sourceIgc}`);
    if (!fs.existsSync(sourceIgc)) {
        console.log('The provided file does not exist');
        return;
    }

    console.log('Reading IGC file...');
    const igc = await readIgcFile(sourceIgc);
    console.log(`Track length: ${igc.fixes.length}`);
    console.log('Processing data...');
    const processedData = await processData(ELEVATION_SERVER_URL, igc);

    const targetFile = path.format({ ...path.parse(sourceIgc), base: undefined, ext: '.csv' });
    console.log(`Writing target file: ${targetFile}`);
    await writeProcessedFile(targetFile, igc.date, processedData);
}

await (async function () {
    await yargs(yh.hideBin(process.argv))
        .command(
            '* <filePath>',
            'Default',
            yargs =>
                yargs.positional('filePath', {
                    describe: 'The IGC file path',
                    type: 'string',
                    demandOption: true,
                }),
            run
        )
        .help()
        .alias('help', 'h')
        .parse();
})();
