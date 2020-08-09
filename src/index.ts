console.time('Bridge loaded');
import { Bridge, Cli, AppServiceRegistration } from 'matrix-appservice-bridge';
import { Client } from './mattermost/Client';
import log from './Logging';
import { setConfig, Config } from './Config';
import { createConnection } from 'typeorm';
import * as path from 'path';
import Main from './Main';
import { User } from './entities/User';
import { Post } from './entities/Post';

const ACCESS_TOKEN = 'o57i1q3o8jbojnkkd8sbjqhuqr';
const cli = new Cli({
    registrationPath: 'registration.yaml',
    generateRegistration(reg, callback) {
        const config: Config = cli.getConfig();

        reg.setId(AppServiceRegistration.generateToken());
        reg.setHomeserverToken(AppServiceRegistration.generateToken());
        reg.setAppServiceToken(AppServiceRegistration.generateToken());
        reg.setSenderLocalpart(`${config.matrix_bot.username}`);
        reg.setAppServiceUrl(
            `${config.appservice.schema}://${config.appservice.hostname}:${config.appservice.port}`,
        );
        reg.addRegexPattern(
            'users',
            `@${config.matrix_localpart_prefix}.*`,
            true,
        );

        callback(reg);
    },
    bridgeConfig: {
        schema: path.join(__dirname, '../config/mattermost-config-schema.yaml'),
        affectsRegistration: true,
    },
    async run(port: number, config: Config, registration: any) {
        log.setLevel(config.logging);

        setConfig(config);

        const db: any = config.database;
        db['entities'] = [User, Post];
        db['synchronize'] = true;
        db['logging'] = false;

        await createConnection(db);

        const main = new Main(registration);
        log.timeEnd.info('Bridge loaded');
        main.init();

        process.on('SIGTERM', async () => {
            log.info('Received SIGTERM. Shutting down bridge.');
            try {
                log.debug('Closing websocket connection');
                await main.ws.close();
                log.debug('Closing appservice bridge');
                await main.bridge.appservice.close();
            } catch (e) {
                log.error('Failed to kill bridge, exiting anyway');
            }
            process.exit(1);
        });
    },
});
cli.run();
