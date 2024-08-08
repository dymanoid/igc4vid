import * as fsp from 'fs/promises';
import * as fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import * as yh from 'yargs/helpers';
import * as xcs from 'igc-xc-score';
import IGCParser from 'igc-parser';

async function readIgcFile(filePath: string): Promise<IGCParser.IGCFile> {
    const igcString = await fsp.readFile(filePath, { encoding: 'utf8' });
    const result = IGCParser.parse(igcString, { lenient: true });
    return result;
}

async function processData(igc: IGCParser.IGCFile, targetFile: string): Promise<void> {
    const solver = xcs.solver(igc, xcs.scoringRules.XContest, { noflight: true });
    let solved = false;
    let result: xcs.Solution;
    do {
        const next = solver.next().value;
        result = next;
        solved = next.optimal || false;
    } while (!solved);

    console.log(`Result CP.d: ${result.scoreInfo?.cp?.d}`);
    await fsp.writeFile(targetFile, JSON.stringify(result.geojson()), {encoding: 'utf8'});
}

async function run(argv: yargs.ArgumentsCamelCase<{}>) {
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
    const targetFile = path.format({ ...path.parse(sourceIgc), base: undefined, ext: '.json' });
    await processData(igc, targetFile);
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
