import { Command } from 'commander';
import chalk from 'chalk';

// Lazy-load command modules to reduce RAM usage at startup
// Each command is only imported when actually executed
const lazyImport = async (modulePath) => {
  const module = await import(modulePath);
  // Most modules export a single default or named function
  return module.default || module[Object.keys(module)[0]];
};

const program = new Command();

program
  .name('claude-phone')
  .description('Voice interface for Claude Code via SIP - Call your AI, and your AI can call you')
  .version('1.0.0');

program
  .command('setup')
  .description('Interactive setup wizard for API keys, 3CX config, and devices')
  .option('--skip-prereqs', 'Skip prerequisite checks (advanced users only)')
  .action(async (options) => {
    try {
      const { setupCommand } = await import('../lib/commands/setup.js');
      await setupCommand(options);
    } catch (error) {
      console.error(chalk.red(`\n✗ Setup failed: ${error.message}\n`));
      process.exit(1);
    }
  });

program
  .command('start')
  .description('Start all services (Docker containers + claude-api-server)')
  .action(async () => {
    try {
      const { startCommand } = await import('../lib/commands/start.js');
      await startCommand();
    } catch (error) {
      console.error(chalk.red(`\n✗ Start failed: ${error.message}\n`));
      process.exit(1);
    }
  });

program
  .command('stop')
  .description('Stop all services')
  .action(async () => {
    try {
      const { stopCommand } = await import('../lib/commands/stop.js');
      await stopCommand();
    } catch (error) {
      console.error(chalk.red(`\n✗ Stop failed: ${error.message}\n`));
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show status of all services')
  .action(async () => {
    try {
      const { statusCommand } = await import('../lib/commands/status.js');
      await statusCommand();
    } catch (error) {
      console.error(chalk.red(`\n✗ Status check failed: ${error.message}\n`));
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('Run health checks on all dependencies and services')
  .action(async () => {
    try {
      const { doctorCommand } = await import('../lib/commands/doctor.js');
      await doctorCommand();
    } catch (error) {
      console.error(chalk.red(`\n✗ Health check failed: ${error.message}\n`));
      process.exit(1);
    }
  });

program
  .command('api-server')
  .description('Start Claude API server for Pi remote connections')
  .option('-p, --port <port>', 'Port to listen on', '3333')
  .action(async (options) => {
    try {
      const port = parseInt(options.port, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        console.error(chalk.red('\n✗ Port must be between 1024 and 65535\n'));
        process.exit(1);
      }
      const { apiServerCommand } = await import('../lib/commands/api-server.js');
      await apiServerCommand({ port });
    } catch (error) {
      console.error(chalk.red(`\n✗ API server failed: ${error.message}\n`));
      process.exit(1);
    }
  });

// Device management subcommands
const device = program
  .command('device')
  .description('Manage SIP devices');

device
  .command('add')
  .description('Add a new device')
  .action(async () => {
    try {
      const { deviceAddCommand } = await import('../lib/commands/device/add.js');
      await deviceAddCommand();
    } catch (error) {
      console.error(chalk.red(`\n✗ Device add failed: ${error.message}\n`));
      process.exit(1);
    }
  });

device
  .command('list')
  .description('List all configured devices')
  .action(async () => {
    try {
      const { deviceListCommand } = await import('../lib/commands/device/list.js');
      await deviceListCommand();
    } catch (error) {
      console.error(chalk.red(`\n✗ Device list failed: ${error.message}\n`));
      process.exit(1);
    }
  });

device
  .command('remove <name>')
  .description('Remove a device by name')
  .action(async (name) => {
    try {
      const { deviceRemoveCommand } = await import('../lib/commands/device/remove.js');
      await deviceRemoveCommand(name);
    } catch (error) {
      console.error(chalk.red(`\n✗ Device remove failed: ${error.message}\n`));
      process.exit(1);
    }
  });

program
  .command('logs [service]')
  .description('Tail service logs (voice-app, api-server, or all)')
  .action(async (service) => {
    try {
      const { logsCommand } = await import('../lib/commands/logs.js');
      await logsCommand(service);
    } catch (error) {
      console.error(chalk.red(`\n✗ Logs command failed: ${error.message}\n`));
      process.exit(1);
    }
  });

// Config management subcommands
const config = program
  .command('config')
  .description('Manage configuration');

config
  .command('show')
  .description('Display configuration with redacted secrets')
  .action(async () => {
    try {
      const { configShowCommand } = await import('../lib/commands/config/show.js');
      await configShowCommand();
    } catch (error) {
      console.error(chalk.red(`\n✗ Config show failed: ${error.message}\n`));
      process.exit(1);
    }
  });

config
  .command('path')
  .description('Show configuration file location')
  .action(async () => {
    try {
      const { configPathCommand } = await import('../lib/commands/config/path.js');
      await configPathCommand();
    } catch (error) {
      console.error(chalk.red(`\n✗ Config path failed: ${error.message}\n`));
      process.exit(1);
    }
  });

config
  .command('reset')
  .description('Reset configuration (creates backup)')
  .action(async () => {
    try {
      const { configResetCommand } = await import('../lib/commands/config/reset.js');
      await configResetCommand();
    } catch (error) {
      console.error(chalk.red(`\n✗ Config reset failed: ${error.message}\n`));
      process.exit(1);
    }
  });

program
  .command('update')
  .description('Update Claude Phone to latest version')
  .action(async () => {
    try {
      const { updateCommand } = await import('../lib/commands/update.js');
      await updateCommand();
    } catch (error) {
      console.error(chalk.red(`\n✗ Update failed: ${error.message}\n`));
      process.exit(1);
    }
  });

program
  .command('backup')
  .description('Create timestamped backup of configuration')
  .action(async () => {
    try {
      const { backupCommand } = await import('../lib/commands/backup.js');
      await backupCommand();
    } catch (error) {
      console.error(chalk.red(`\n✗ Backup failed: ${error.message}\n`));
      process.exit(1);
    }
  });

program
  .command('restore')
  .description('Restore configuration from backup')
  .action(async () => {
    try {
      const { restoreCommand } = await import('../lib/commands/restore.js');
      await restoreCommand();
    } catch (error) {
      console.error(chalk.red(`\n✗ Restore failed: ${error.message}\n`));
      process.exit(1);
    }
  });

program
  .command('uninstall')
  .description('Uninstall Claude Phone completely')
  .action(async () => {
    try {
      const { uninstallCommand } = await import('../lib/commands/uninstall.js');
      await uninstallCommand();
    } catch (error) {
      console.error(chalk.red(`\n✗ Uninstall failed: ${error.message}\n`));
      process.exit(1);
    }
  });

// Parse arguments
program.parse(process.argv);

// Show help if no command
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
