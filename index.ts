import * as fsp from 'fs/promises';
import * as fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import yargs from 'yargs';
import * as yh from 'yargs/helpers';

interface TrackPoint {
    readonly time: string;
    readonly latDeg: number;
    readonly lonDeg: number;
    readonly gpsAlt: number;
}

interface IgcFile {
    readonly flightDate: string;
    readonly trackPoints: TrackPoint[];
}

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
}

async function readIgcFile(filePath: string): Promise<IgcFile> {
    const trackPoints: TrackPoint[] = [];
    let flightDate: string = '';
    const igcFile = await fsp.open(filePath);
    try {
        for await (const line of igcFile.readLines()) {
            if (line.startsWith('HFDTE')) {
                const dateString = line.substring(10, 21);
                const day = dateString.substring(0, 2);
                const month = dateString.substring(2, 4);
                const year = '20' + dateString.substring(4, 6);
                flightDate = `${year}-${month}-${day}`;
            } else if (line.startsWith('B')) {
                const timeStr = line.substring(1, 7);
                const lat = parseInt(line.substring(7, 14));
                const lon = parseInt(line.substring(15, 23));
                const gpsAlt = parseInt(line.substring(25, 30));
                let latDeg = ~~(lat / 100000) + (lat % 100000) / 60000.0;
                let lonDeg = ~~(lon / 100000) + (lon % 100000) / 60000.0;
                if (line[14] == 'S') {
                    latDeg = -latDeg;
                }
                if (line[23] == 'W') {
                    lonDeg = -lonDeg;
                }
                const time = `${timeStr.substring(0, 2)}:${timeStr.substring(2, 4)}:${timeStr.substring(4, 6)}`;
                trackPoints.push({ time, latDeg, lonDeg, gpsAlt });
            }
        }
    } finally {
        await igcFile.close();
    }

    return { flightDate, trackPoints };
}

async function getGroundElevations(server: string, trackPoints: TrackPoint[]): Promise<number[]> {
    const CHUNK_SIZE = 100;
    let result: number[] = [];
    const dataLength = trackPoints.length;

    for (let i = 0; i < dataLength; i += CHUNK_SIZE) {
        const chunk = trackPoints.slice(i, i + CHUNK_SIZE);
        const locations = chunk.map(t => `${t.latDeg.toFixed(5)}, ${t.lonDeg.toFixed(5)}`).join('|');

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

async function processData(elevationServer: string, trackPoints: TrackPoint[]): Promise<TargetData[]> {
    console.log('Getting elevation data...');
    const elevations = await getGroundElevations(elevationServer, trackPoints);
    console.log(`Elevation data size: ${elevations.length}`);
    const processedData: TargetData[] = [];
    console.log('Calculating target dataset...');
    trackPoints.forEach(({ time, gpsAlt }, i) => {
        const groundElev = elevations[i];
        processedData.push({ time, gpsAlt, groundElev });
    });

    return processedData;
}

async function writeProcessedFile(filePath: string, flightDate: string, processedData: TargetData[]) {
    const file = await fsp.open(filePath, 'w');
    try {
        await file.write('date,altitude(m),ground alt (m),agl (m)\n');
        for (const { time, groundElev, gpsAlt } of processedData) {
            await file.write(
                `${flightDate}T${time}Z,${gpsAlt},${groundElev.toFixed(0)},${(gpsAlt - groundElev).toFixed(0)}\n`
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
    const { flightDate, trackPoints } = await readIgcFile(sourceIgc);
    console.log(`Track length: ${trackPoints.length}`);
    console.log('Processing data...');
    const processedData = await processData(ELEVATION_SERVER_URL, trackPoints);

    const targetFile = path.format({ ...path.parse(sourceIgc), base: undefined, ext: '.csv' });
    console.log(`Writing target file: ${targetFile}`);
    await writeProcessedFile(targetFile, flightDate, processedData);
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
