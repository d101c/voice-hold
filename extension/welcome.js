import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import {BUS_NAME} from './engine.js';

// The engine cannot be in the extension's zip: right after the extension is
// installed nothing can be dictated yet. Say so once, with a button that
// opens the Installation page.

// Resolves to true when the engine is on the bus or can be started by it,
// false when it is not installed, null when the bus did not answer.
export function engineInstalled(cancellable = null) {
    const names = method => new Promise(resolve => {
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            method, null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, 5000, cancellable,
            (conn, res) => {
                try {
                    resolve(conn.call_finish(res).deepUnpack()[0]);
                } catch {
                    resolve(null);
                }
            });
    });
    return Promise.all([names('ListActivatableNames'), names('ListNames')]).then(([a, n]) => {
        if (!a || !n)
            return null;
        return a.includes(BUS_NAME) || n.includes(BUS_NAME);
    });
}

// A notification with one button. Returns the source, to destroy on disable.
export function notifySetup({title, body, action, iconName, onActivate}) {
    const major = parseInt(Config.PACKAGE_VERSION);
    let source, notification;
    if (major >= 46) {
        source = new MessageTray.Source({title: 'Voice Hold', iconName});
        Main.messageTray.add(source);
        notification = new MessageTray.Notification({source, title, body, urgency: MessageTray.Urgency.CRITICAL});
        notification.connect('activated', onActivate);
        notification.addAction(action, onActivate);
        source.addNotification(notification);
    } else {
        source = new MessageTray.Source('Voice Hold', iconName);
        Main.messageTray.add(source);
        notification = new MessageTray.Notification(source, title, body);
        notification.setUrgency(MessageTray.Urgency.CRITICAL);
        notification.connect('activated', onActivate);
        notification.addAction(action, onActivate);
        source.showNotification(notification);
    }
    return source;
}
