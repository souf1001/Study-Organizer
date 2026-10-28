package de.studyorganizer.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * Hosts the web UI. The Android back button is handled in JavaScript through the official
 * App plugin (see src/renderer/src/mobile/android.ts).
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before the bridge starts
        registerPlugin(WebLoginPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
